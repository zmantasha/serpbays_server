'use strict';

/**
 * GET /admin/search?q=...   (2026-10-13, powers the ⌘K command palette)
 *
 * One box to find users, orders, marketplace listings, publisher sites,
 * transactions and withdrawals. A number also matches record ids. Each group
 * is returned only if the admin can view that page. Read-only, ≤ 6 hits each.
 */

function canView(user, key) {
  if (user && user.role && user.role.type === 'super_admin') return true;
  const e = ((user && user.pagePermissions) || {})[key];
  return !!e && (!!e.view || !!e.edit || !!e.create || !!e.delete);
}

module.exports = {
  async search(ctx) {
    const raw = String(ctx.query.q || '').trim().slice(0, 100);
    if (raw.length < 2 && !/^\d+$/.test(raw)) return ctx.send({ q: raw, groups: [] });
    const user = ctx.state.user;
    const knex = strapi.db.connection;
    const num = /^#?\d+$/.test(raw) ? parseInt(raw.replace('#', ''), 10) : null;
    const text = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
    const like = `%${text.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    const groups = [];
    const run = async (key, label, fn) => {
      if (!canView(user, key)) return;
      try {
        const items = await fn();
        if (items.length) groups.push({ key, label, items });
      } catch (e) {
        strapi.log.warn(`[admin search] ${key}: ${e.message}`);
      }
    };

    await Promise.all([
      run('users', 'Users', async () => (await knex.raw(
        `select id, username, email, business_name from up_users
          where (?::int is not null and id = ?::int) or username ilike ? or email ilike ? or coalesce(business_name,'') ilike ?
          order by (id = coalesce(?::int, -1)) desc, created_at desc limit 6`, [num, num, like, like, like, num])).rows
        .map((r) => ({ id: r.id, title: r.username || r.email, subtitle: [r.email, r.business_name].filter(Boolean).join(' · '), href: `/users/${r.id}` }))),
      run('orders', 'Orders', async () => (await knex.raw(
        `select o.id, o.website_url, o.order_status, o.total_amount, u.email
           from orders o left join orders_advertiser_lnk l on l.order_id = o.id left join up_users u on u.id = l.user_id
          where (?::int is not null and o.id = ?::int) or o.website_url ilike ? or u.email ilike ?
          order by (o.id = coalesce(?::int, -1)) desc, o.created_at desc limit 6`, [num, num, like, like, num])).rows
        .map((r) => ({ id: r.id, title: `Order #${r.id}${r.website_url ? ` · ${r.website_url}` : ''}`, subtitle: [r.order_status, r.total_amount != null ? `$${Number(r.total_amount)}` : null, r.email].filter(Boolean).join(' · '), href: `/orders/${r.id}` }))),
      run('marketplace', 'Marketplace listings', async () => (await knex.raw(
        `select id, url, status, price from marketplaces
          where (?::int is not null and id = ?::int) or url ilike ?
          order by (id = coalesce(?::int, -1)) desc, (lower(url) = lower(?::text)) desc, ahrefs_dr desc nulls last limit 6`, [num, num, like, num, text])).rows
        .map((r) => ({ id: r.id, title: r.url, subtitle: [r.status, r.price != null ? `$${Number(r.price)}` : null, `listing #${r.id}`].filter(Boolean).join(' · '), href: `/marketplace/${r.id}` }))),
      run('websites', 'Publisher sites', async () => (await knex.raw(
        `select id, url, submission_status, publisher_email from publisher_websites
          where (?::int is not null and id = ?::int) or url ilike ? or coalesce(publisher_email,'') ilike ?
          order by (id = coalesce(?::int, -1)) desc, (lower(url) = lower(?::text)) desc, updated_at desc limit 5`, [num, num, like, like, num, text])).rows
        .map((r) => ({ id: r.id, title: r.url, subtitle: [String(r.submission_status || '').replace(/_/g, ' '), r.publisher_email, `site #${r.id}`].filter(Boolean).join(' · '), href: `/websites/${r.id}` }))),
      run('transactions', 'Transactions', async () => (num == null && text.length < 6) ? [] : (await knex.raw(
        `select id, type, amount, transaction_status, gateway from transactions
          where (?::int is not null and id = ?::int) or (length(?::text) >= 6 and (gateway_transaction_id ilike ? or external_transaction_id ilike ?))
          order by created_at desc limit 5`, [num, num, text, like, like])).rows
        .map((r) => ({ id: r.id, title: `Transaction #${r.id} · ${r.type}`, subtitle: [`$${Number(r.amount)}`, r.transaction_status, r.gateway].filter(Boolean).join(' · '), href: `/transactions/${r.id}` }))),
      run('withdrawals', 'Withdrawals', async () => num == null ? [] : (await knex.raw(
        `select id, amount, withdrawal_status, method from withdrawal_requests where id = ? limit 3`, [num])).rows
        .map((r) => ({ id: r.id, title: `Withdrawal #${r.id}`, subtitle: [`$${Number(r.amount)}`, r.withdrawal_status, r.method].filter(Boolean).join(' · '), href: `/withdrawals/${r.id}` }))),
    ]);
    const order = ['orders', 'users', 'marketplace', 'websites', 'transactions', 'withdrawals'];
    groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    ctx.send({ q: raw, groups });
  },
};
