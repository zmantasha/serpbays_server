'use strict';

/**
 * GET /admin/payments/failed?days=90   (2026-10-13)
 *
 * Deposits that failed, or are still "pending" after an hour (checkout
 * abandoned or the gateway webhook never came), grouped by user, with
 * whether that user later deposited successfully ("recovered"). This is a
 * follow-up list for the team: people who wanted to pay and couldn't.
 * Needs Transactions view. Test accounts are excluded.
 */
function canView(user) {
  if (user && user.role && user.role.type === 'super_admin') return true;
  const e = ((user && user.pagePermissions) || {}).transactions;
  return !!e && (!!e.view || !!e.edit);
}

module.exports = {
  async failed(ctx) {
    if (!canView(ctx.state.user)) return ctx.forbidden('No access to transactions');
    const days = Math.min(365, Math.max(1, parseInt(ctx.query.days, 10) || 90));
    const knex = strapi.db.connection;
    const rows = (await knex.raw(`
      with tx as (
        select t.id, t.amount, t.gateway, t.transaction_status as status, t.created_at, ul.user_id
          from transactions t
          join transactions_users_permissions_user_lnk ul on ul.transaction_id = t.id
         where t.type = 'deposit' and t.gateway in ('stripe','paypal','razorpay','bank_transfer')
      ),
      bad as (
        select * from tx
         where created_at > now() - (? || ' days')::interval
           and (status = 'failed' or (status = 'pending' and created_at < now() - interval '1 hour'))
           and user_id not in (select user_id from reporting.test_user_ids)
      )
      select b.user_id, u.username, u.email, coalesce(nullif(u.first_name,''), u.username) as name, u.phone_number, u.country,
             count(*)::int as attempts, sum(b.amount) as amount_tried, max(b.created_at) as last_attempt,
             array_agg(distinct b.gateway) as gateways,
             array_agg(distinct b.status) as statuses,
             (select max(s.created_at) from tx s where s.user_id = b.user_id and s.status in ('success','completed','paid') and s.created_at > min(b.created_at)) as recovered_at,
             (select coalesce(sum(s.amount),0) from tx s where s.user_id = b.user_id and s.status in ('success','completed','paid')) as lifetime_paid
        from bad b join up_users u on u.id = b.user_id
       group by b.user_id, u.username, u.email, u.first_name, u.phone_number, u.country
       order by (select max(s.created_at) from tx s where s.user_id = b.user_id and s.status in ('success','completed','paid') and s.created_at > min(b.created_at)) is not null, max(b.created_at) desc`, [String(days)])).rows;
    const n = (v) => Math.round(Number(v || 0) * 100) / 100;
    const data = rows.map((r) => ({
      userId: r.user_id, name: r.name, email: r.email, phone: r.phone_number || null, country: r.country || null,
      attempts: r.attempts, amountTried: n(r.amount_tried), lastAttempt: r.last_attempt,
      gateways: r.gateways, statuses: r.statuses, recoveredAt: r.recovered_at, lifetimePaid: n(r.lifetime_paid),
    }));
    const open = data.filter((d) => !d.recoveredAt);
    ctx.send({
      days,
      summary: { users: data.length, notRecovered: open.length, amountNotRecovered: n(open.reduce((s, d) => s + d.amountTried, 0)), recovered: data.length - open.length },
      data,
    });
  },
};
