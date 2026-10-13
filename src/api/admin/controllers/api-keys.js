'use strict';

/**
 * Admin: customer API keys (2026-10-13). Super admin only.
 *
 *   GET    /admin/api-keys                 keys + usage (today / 7 days / 30 days)
 *   POST   /admin/api-keys                 { userId?, label, perMinute?, perDay?, expiresAt?, notes? } → returns the full key ONCE
 *   PUT    /admin/api-keys/:id             { label?, perMinute?, perDay?, expiresAt?, notes?, status?: 'active'|'revoked' }
 *   GET    /admin/api-keys/:id/usage       last 30 days, per day
 */
const svc = () => require('../../partner/services/api-keys');
const isSuper = (u) => u && u.role && u.role.type === 'super_admin';
const audit = (ctx, action, details) => strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
  data: { adminUser: ctx.state.user.id, action, details, ipAddress: ctx.request.ip || null, createdAt: new Date(), updatedAt: new Date() },
}).catch(() => {});
const lim = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

module.exports = {
  async list(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await svc().ensure();
    const rows = (await strapi.db.connection.raw(`select k.id, k.user_id, k.label, k.key_prefix, k.scopes, k.per_minute, k.per_day, k.status, k.expires_at, k.notes,
        k.created_at, k.revoked_at, k.last_used_at, k.last_used_ip, u.email, u.username,
        coalesce((select requests from api_usage_daily d where d.key_id = k.id and d.day = current_date), 0) today,
        coalesce((select sum(requests) from api_usage_daily d where d.key_id = k.id and d.day > current_date - 7), 0)::int last7,
        coalesce((select sum(requests) from api_usage_daily d where d.key_id = k.id and d.day > current_date - 30), 0)::int last30
        from api_keys k left join up_users u on u.id = k.user_id order by k.status, k.created_at desc`)).rows;
    ctx.send({ data: rows });
  },
  async create(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await svc().ensure();
    const b = ctx.request.body || {};
    const label = String(b.label || '').trim().slice(0, 100);
    if (label.length < 2) return ctx.badRequest('Give the key a name, e.g. the customer or their tool');
    const userId = b.userId ? parseInt(b.userId, 10) : null;
    if (userId) { const u = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: userId }, select: ['id'] }); if (!u) return ctx.badRequest('Customer not found'); }
    const key = svc().newKey();
    const exp = b.expiresAt ? new Date(b.expiresAt) : null;
    if (exp && Number.isNaN(exp.getTime())) return ctx.badRequest('expiresAt is not a date');
    const row = (await strapi.db.connection.raw(`insert into api_keys (user_id, label, key_prefix, key_hash, per_minute, per_day, expires_at, notes, created_by)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id, key_prefix`, [userId, label, key.slice(0, 14), svc().hash(key), lim(b.perMinute, 60, 1, 1000), lim(b.perDay, 10000, 10, 1000000), exp, String(b.notes || '').slice(0, 1000) || null, ctx.state.user.id])).rows[0];
    await audit(ctx, 'api_key.create', { id: row.id, label, userId, prefix: row.key_prefix });
    ctx.send({ id: row.id, key, prefix: row.key_prefix, note: 'Copy this key now. It is not shown again.' });
  },
  async update(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await svc().ensure();
    const id = parseInt(ctx.params.id, 10);
    const b = ctx.request.body || {};
    const cur = (await strapi.db.connection.raw('select * from api_keys where id = ?', [id])).rows[0];
    if (!cur) return ctx.notFound('Key not found');
    const set = {};
    if (b.label !== undefined) set.label = String(b.label).trim().slice(0, 100) || cur.label;
    if (b.perMinute !== undefined) set.per_minute = lim(b.perMinute, cur.per_minute, 1, 1000);
    if (b.perDay !== undefined) set.per_day = lim(b.perDay, cur.per_day, 10, 1000000);
    if (b.notes !== undefined) set.notes = String(b.notes || '').slice(0, 1000) || null;
    if (b.expiresAt !== undefined) { const d = b.expiresAt ? new Date(b.expiresAt) : null; if (d && Number.isNaN(d.getTime())) return ctx.badRequest('expiresAt is not a date'); set.expires_at = d; }
    if (b.status === 'revoked' && cur.status !== 'revoked') { set.status = 'revoked'; set.revoked_at = new Date(); set.revoked_by = ctx.state.user.id; }
    if (b.status === 'active' && cur.status !== 'active') { set.status = 'active'; set.revoked_at = null; set.revoked_by = null; }
    if (!Object.keys(set).length) return ctx.badRequest('Nothing to change');
    await strapi.db.connection('api_keys').where({ id }).update(set);
    svc().invalidate();
    await audit(ctx, set.status === 'revoked' ? 'api_key.revoke' : 'api_key.update', { id, changes: Object.keys(set) });
    ctx.send({ ok: true });
  },
  async usage(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await svc().ensure();
    const rows = (await strapi.db.connection.raw(`select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(u.requests, 0)::int as requests, coalesce(u.errors, 0)::int as errors, coalesce(u.rows_returned, 0)::int as rows_returned
        from generate_series(current_date - 29, current_date, interval '1 day') d(day) left join api_usage_daily u on u.day = d.day::date and u.key_id = ? order by 1`, [parseInt(ctx.params.id, 10)])).rows;
    ctx.send({ data: rows });
  },
};
