'use strict';

/**
 * Sales follow-up (CRM-lite) for buyers, 2026-10-13.
 *
 * Demand is the bottleneck (hundreds of signups, a dozen paying buyers), so the
 * team needs one list of who to contact today and a record of each follow-up.
 *
 *   GET  /admin/sales/queue          → today's work, in sections
 *   GET  /admin/sales/leads/:userId  → follow-up state for one user
 *   PUT  /admin/sales/leads/:userId  { status?, nextFollowUp?, ownerId?, note?, contacted? }
 *
 * State lives in `crm_leads` (created on first use). Notes go to the same
 * user-notes log as the profile page (admin_audit_logs, action user_note).
 * Test/internal accounts are excluded. Needs Users view (edit to change).
 */
const STATUSES = ['new', 'contacted', 'interested', 'won', 'lost'];
let ready = null;
function ensure() {
  if (!ready) {
    ready = strapi.db.connection.raw(`create table if not exists crm_leads (
        user_id int primary key, status text not null default 'new', next_follow_up date, owner_admin_id int,
        last_contacted_at timestamptz, contacts int not null default 0, updated_at timestamptz not null default now(), updated_by int)`)
      .then(() => strapi.db.connection.raw('create index if not exists crm_leads_follow_idx on crm_leads (next_follow_up)'))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}
function can(user, kind) {
  if (user && user.role && user.role.type === 'super_admin') return true;
  const e = ((user && user.pagePermissions) || {}).users;
  return !!e && (kind === 'view' ? (!!e.view || !!e.edit) : !!e.edit);
}

const BASE = `
  with dep as (
    select ul.user_id, min(t.created_at) first_dep, sum(t.amount) dep_total
      from transactions t join transactions_users_permissions_user_lnk ul on ul.transaction_id = t.id
     where t.type = 'deposit' and t.transaction_status in ('success','completed','paid') and t.gateway in ('stripe','paypal','razorpay','bank_transfer')
     group by 1),
  ord as (
    select l.user_id, count(*)::int n, max(o.created_at) last_order
      from orders o join orders_advertiser_lnk l on l.order_id = o.id group by 1),
  wal as (
    select l.user_id, w.main_balance from user_wallets w join user_wallets_users_permissions_user_lnk l on l.user_wallet_id = w.id),
  base as (
    select u.id, coalesce(nullif(trim(concat(u.first_name, ' ', u.last_name)), ''), u.username) as name, u.email, u.phone_number as phone,
           coalesce(nullif(u.country, ''), u.signup_country) as country, u.business_name, u.created_at,
           coalesce(dep.dep_total, 0) dep_total, dep.first_dep, coalesce(ord.n, 0) orders, ord.last_order, coalesce(wal.main_balance, 0) wallet,
           c.status, c.next_follow_up, c.owner_admin_id, c.last_contacted_at, coalesce(c.contacts, 0) contacts
      from up_users u
      left join dep on dep.user_id = u.id left join ord on ord.user_id = u.id left join wal on wal.user_id = u.id
      left join crm_leads c on c.user_id = u.id
     where not coalesce(u.blocked, false)
       and u.id not in (select user_id from reporting.test_user_ids)
       and coalesce(u.advertiser, false))`;
const free = `(next_follow_up is null or next_follow_up <= current_date) and coalesce(status, 'new') not in ('won', 'lost')`;

const shape = (r) => ({
  userId: r.id, name: r.name, email: r.email, phone: r.phone || null, country: r.country || null, business: r.business_name || null,
  signedUp: r.created_at, deposited: Math.round(Number(r.dep_total) * 100) / 100, firstDeposit: r.first_dep, orders: r.orders,
  lastOrder: r.last_order, wallet: Math.round(Number(r.wallet) * 100) / 100,
  status: r.status || 'new', nextFollowUp: r.next_follow_up, ownerId: r.owner_admin_id, lastContacted: r.last_contacted_at, contacts: r.contacts,
});

async function queue() {
  await ensure();
  const knex = strapi.db.connection;
  const q = async (where, order) => (await knex.raw(`${BASE} select * from base where ${where} order by ${order} limit 60`)).rows.map(shape);
  const [due, newSignups, fundedNoOrder, idleWallets] = await Promise.all([
    q(`next_follow_up is not null and next_follow_up <= current_date and coalesce(status,'new') not in ('won','lost')`, 'next_follow_up, id'),
    q(`created_at > now() - interval '14 days' and created_at < now() - interval '12 hours' and dep_total = 0 and coalesce(status,'new') = 'new' and next_follow_up is null`, 'created_at desc'),
    q(`dep_total > 0 and orders = 0 and first_dep < now() - interval '2 days' and ${free}`, 'wallet desc'),
    q(`wallet >= 5 and orders > 0 and last_order < now() - interval '30 days' and ${free}`, 'wallet desc'),
  ]);
  return { due, newSignups, fundedNoOrder, idleWallets };
}

module.exports = {
  queue,
  async getQueue(ctx) {
    if (!can(ctx.state.user, 'view')) return ctx.forbidden('No access to users');
    const q = await queue();
    const admins = (await strapi.db.connection.raw(`select u.id, u.username from up_users u join up_users_role_lnk l on l.user_id = u.id join up_roles r on r.id = l.role_id where r.type in ('admin','super_admin') and not coalesce(u.blocked,false) order by u.id`)).rows;
    ctx.send({ ...q, admins, counts: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.length])) });
  },
  async getLead(ctx) {
    if (!can(ctx.state.user, 'view')) return ctx.forbidden('No access to users');
    await ensure();
    const id = parseInt(ctx.params.userId, 10);
    const r = (await strapi.db.connection.raw('select * from crm_leads where user_id = ?', [id])).rows[0];
    ctx.send({ userId: id, status: (r && r.status) || 'new', nextFollowUp: r ? r.next_follow_up : null, ownerId: r ? r.owner_admin_id : null, lastContacted: r ? r.last_contacted_at : null, contacts: r ? r.contacts : 0 });
  },
  async setLead(ctx) {
    if (!can(ctx.state.user, 'edit')) return ctx.forbidden('Needs Users edit permission');
    await ensure();
    const id = parseInt(ctx.params.userId, 10);
    const b = ctx.request.body || {};
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id }, select: ['id'] });
    if (!user) return ctx.notFound('User not found');
    if (b.status !== undefined && !STATUSES.includes(b.status)) return ctx.badRequest(`status must be one of ${STATUSES.join(', ')}`);
    const next = b.nextFollowUp === null || b.nextFollowUp === '' ? null : (b.nextFollowUp !== undefined ? String(b.nextFollowUp).slice(0, 10) : undefined);
    if (next && !/^\d{4}-\d{2}-\d{2}$/.test(next)) return ctx.badRequest('nextFollowUp must be YYYY-MM-DD');
    const note = String(b.note || '').trim().slice(0, 2000);
    const contacted = !!b.contacted;
    const knex = strapi.db.connection;
    await knex.raw(`insert into crm_leads (user_id, status, next_follow_up, owner_admin_id, last_contacted_at, contacts, updated_at, updated_by)
        values (?, coalesce(?, 'new'), ?, ?, case when ? then now() end, case when ? then 1 else 0 end, now(), ?)
        on conflict (user_id) do update set
          status = coalesce(?, crm_leads.status),
          next_follow_up = case when ? then ?::date else crm_leads.next_follow_up end,
          owner_admin_id = case when ? then ? else crm_leads.owner_admin_id end,
          last_contacted_at = case when ? then now() else crm_leads.last_contacted_at end,
          contacts = crm_leads.contacts + case when ? then 1 else 0 end,
          updated_at = now(), updated_by = ?`,
      [id, b.status || null, next === undefined ? null : next, b.ownerId != null ? Number(b.ownerId) : null, contacted, contacted, ctx.state.user.id,
        b.status || null, next !== undefined, next === undefined ? null : next, b.ownerId !== undefined, b.ownerId != null ? Number(b.ownerId) : null, contacted, contacted, ctx.state.user.id]);
    if (note || contacted || b.status) {
      const text = [contacted ? 'Contacted.' : '', b.status ? `Lead status: ${b.status}.` : '', next ? `Next follow-up ${next}.` : '', note].filter(Boolean).join(' ');
      await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
        data: { adminUser: ctx.state.user.id, action: 'user_note', targetUser: id, details: { note: text, source: 'sales' }, ipAddress: ctx.request.ip || null, createdAt: new Date(), updatedAt: new Date() },
      }).catch(() => {});
    }
    const r = (await knex.raw('select * from crm_leads where user_id = ?', [id])).rows[0];
    ctx.send({ userId: id, status: r.status, nextFollowUp: r.next_follow_up, ownerId: r.owner_admin_id, lastContacted: r.last_contacted_at, contacts: r.contacts });
  },
};
