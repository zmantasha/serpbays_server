'use strict';

/**
 * CSV exports for the ops team (2026-10-13).
 *
 *   GET /admin/export/orders?status=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET /admin/export/transactions?type=&status=&from=&to=
 *   GET /admin/export/withdrawals?status=&from=&to=
 *
 * Needs view access to that page. Max 20,000 rows. Each download is written
 * to the admin audit log (who exported what).
 */

const PAGE = { orders: 'orders', transactions: 'transactions', withdrawals: 'withdrawals' };

function canView(user, key) {
  if (user && user.role && user.role.type === 'super_admin') return true;
  const e = ((user && user.pagePermissions) || {})[key];
  return !!e && (!!e.view || !!e.edit || !!e.create || !!e.delete);
}
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // keep spreadsheets from treating text as formulas
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

module.exports = {
  async exportCsv(ctx) {
    const kind = String(ctx.params.kind || '');
    if (!PAGE[kind]) return ctx.notFound('Unknown export');
    if (!canView(ctx.state.user, PAGE[kind])) return ctx.forbidden('No access');
    const knex = strapi.db.connection;
    const q = ctx.query || {};
    const from = day(q.from), to = day(q.to);
    const where = []; const b = [];
    const t = { orders: 'o', transactions: 't', withdrawals: 'w' }[kind];
    if (from) { where.push(`${t}.created_at >= ?::date`); b.push(from); }
    if (to) { where.push(`${t}.created_at < (?::date + 1)`); b.push(to); }
    let sql;
    if (kind === 'orders') {
      if (q.status && q.status !== 'All') { where.push('o.order_status = ?'); b.push(String(q.status)); }
      sql = `select o.id, o.created_at, o.order_status as status, o.service_type, o.website_url, o.total_amount, o.website_publisher_price as publisher_price,
                    a.email as buyer_email, p.email as publisher_email, o.accepted_date, o.delivered_date, o.completed_date, o.cancelled_at,
                    o.rejection_reason, o.cancellation_reason, o.website_assured as assured
               from orders o
               left join orders_advertiser_lnk al on al.order_id = o.id left join up_users a on a.id = al.user_id
               left join orders_publisher_lnk pl on pl.order_id = o.id left join up_users p on p.id = pl.user_id`;
    } else if (kind === 'transactions') {
      if (q.status && q.status !== 'All') { where.push('t.transaction_status = ?'); b.push(String(q.status)); }
      if (q.type && q.type !== 'All') { where.push('t.type = ?'); b.push(String(q.type)); }
      sql = `select t.id, t.created_at, t.type, t.amount, t.fee, t.net_amount, t.transaction_status as status, t.gateway, t.gateway_transaction_id,
                    u.email as user_email, ol.order_id, t.description
               from transactions t
               left join transactions_users_permissions_user_lnk ul on ul.transaction_id = t.id left join up_users u on u.id = ul.user_id
               left join transactions_order_lnk ol on ol.transaction_id = t.id`;
    } else {
      if (q.status && q.status !== 'All') { where.push('w.withdrawal_status = ?'); b.push(String(q.status)); }
      sql = `select w.id, w.created_at, w.amount, w.method, w.withdrawal_status as status, u.email as publisher_email,
                    w.payment_reference, w.external_transaction_id, w.approved_at, w.paid_at, w.rejected_at, w.denial_reason
               from withdrawal_requests w
               left join withdrawal_requests_publisher_lnk pl on pl.withdrawal_request_id = w.id left join up_users u on u.id = pl.user_id`;
    }
    sql += (where.length ? ` where ${where.join(' and ')}` : '') + ` order by ${t}.created_at desc limit 20000`;
    const rows = (await knex.raw(sql, b)).rows;
    const cols = rows.length ? Object.keys(rows[0]) : ['id'];
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
    await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
      data: { adminUser: ctx.state.user.id, action: 'export_csv', details: { kind, rows: rows.length, filters: { from, to, status: q.status || null, type: q.type || null } }, ipAddress: ctx.request.ip || null, createdAt: new Date(), updatedAt: new Date() },
    }).catch(() => {});
    ctx.set('Content-Type', 'text/csv; charset=utf-8');
    ctx.set('Content-Disposition', `attachment; filename="serpbays-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
    ctx.body = '﻿' + csv;
  },
};
