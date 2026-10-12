'use strict';

/**
 * Today's transactions for the dashboard.
 *
 *   GET /admin/dashboard/today-transactions?tz=Asia/Kolkata
 *
 * "Today" starts at midnight in the given IANA time zone (default Asia/Kolkata,
 * where the team works). Returns every transaction since then (all statuses,
 * newest first, max 200) with the user and order it belongs to, plus a summary.
 * Read-only.
 */

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const money = (v) => Math.round(n(v) * 100) / 100;
const OK = ['success', 'paid', 'approved', 'completed'];
const REAL_GATEWAYS = ['stripe', 'paypal', 'razorpay', 'bank_transfer'];

function canView(user) {
  const t = user && user.role && user.role.type;
  if (t === 'super_admin') return true;
  const perms = (user && user.pagePermissions) || {};
  const e = perms.transactions;
  return !!e && (!!e.view || !!e.edit || !!e.delete);
}

module.exports = {
  async today(ctx) {
    if (!canView(ctx.state.user)) return ctx.forbidden('No access to transactions');
    const tz = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(String(ctx.query.tz || '')) ? String(ctx.query.tz) : 'Asia/Kolkata';
    const knex = strapi.db.connection;
    const rows = (await knex.raw(`
      with bounds as (select (date_trunc('day', now() at time zone ?) at time zone ?) as start)
      select t.id, t.type, t.gateway, t.amount, t.transaction_status as status, t.created_at, t.description,
             ul.user_id, u.username, u.email, coalesce(nullif(u.business_name,''), nullif(trim(concat(u.first_name,' ',u.last_name)),''), u.username) as name,
             ol.order_id, o.website_url
        from transactions t
        cross join bounds b
        left join transactions_users_permissions_user_lnk ul on ul.transaction_id = t.id
        left join up_users u on u.id = ul.user_id
        left join transactions_order_lnk ol on ol.transaction_id = t.id
        left join orders o on o.id = ol.order_id
       where t.created_at >= b.start
       order by t.created_at desc, t.id desc
       limit 200`, [tz, tz])).rows;
    const start = (await knex.raw(`select (date_trunc('day', now() at time zone ?) at time zone ?) as start`, [tz, tz])).rows[0].start;

    const ok = (r) => OK.includes(r.status);
    const sum = (f) => money(rows.filter(f).reduce((s, r) => s + n(r.amount), 0));
    const cnt = (f) => rows.filter(f).length;
    const isCash = (r) => r.type === 'deposit' && REAL_GATEWAYS.includes(r.gateway);
    const summary = {
      cashIn: { amount: sum((r) => isCash(r) && ok(r)), count: cnt((r) => isCash(r) && ok(r)) },
      failedDeposits: { amount: sum((r) => isCash(r) && r.status === 'failed'), count: cnt((r) => isCash(r) && r.status === 'failed') },
      pendingDeposits: { amount: sum((r) => isCash(r) && r.status === 'pending'), count: cnt((r) => isCash(r) && r.status === 'pending') },
      ordersPaid: { amount: sum((r) => r.type === 'payment' && ok(r)), count: cnt((r) => r.type === 'payment' && ok(r)) },
      refunds: { amount: sum((r) => r.type === 'refund' && ok(r)), count: cnt((r) => r.type === 'refund' && ok(r)) },
      withdrawals: { amount: sum((r) => r.type === 'withdrawal'), count: cnt((r) => r.type === 'withdrawal') },
      releasedToPublishers: { amount: sum((r) => r.type === 'escrow_release' && ok(r)), count: cnt((r) => r.type === 'escrow_release' && ok(r)) },
      addedBySerpbays: { amount: sum((r) => r.type === 'deposit' && r.gateway === 'system' && ok(r)), count: cnt((r) => r.type === 'deposit' && r.gateway === 'system' && ok(r)) },
      promo: { amount: sum((r) => r.type === 'promo' && ok(r)), count: cnt((r) => r.type === 'promo' && ok(r)) },
      total: rows.length,
    };

    ctx.send({
      tz, since: start, generatedAt: new Date().toISOString(), truncated: rows.length >= 200, summary,
      items: rows.map((r) => ({
        id: r.id, type: r.type, gateway: r.gateway, amount: money(r.amount), status: r.status, createdAt: r.created_at, description: r.description || null,
        user: r.user_id ? { id: r.user_id, name: r.name, email: r.email } : null,
        order: r.order_id ? { id: r.order_id, site: r.website_url || null } : null,
      })),
    });
  },
};
