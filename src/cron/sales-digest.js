'use strict';

/**
 * Morning sales digest (2026-10-13): at 03:30 UTC (09:00 IST) email every
 * active admin the day's follow-ups from /admin/sales/queue. Skipped when
 * there is nothing to do. Disable with SALES_DIGEST_ENABLED=false.
 */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

module.exports = {
  salesDigest: {
    task: async ({ strapi }) => {
      if (String(process.env.SALES_DIGEST_ENABLED || 'true') === 'false') return;
      const q = await require('../api/admin/controllers/sales').queue();
      const total = q.due.length + q.newSignups.length + q.fundedNoOrder.length + q.idleWallets.length;
      if (!total) return;
      const panel = process.env.ADMIN_PANEL_URL || 'https://prod-panel20.serpbays.com';
      const rows = (list, why) => list.slice(0, 10).map((r) =>
        `<tr><td style="padding:4px 8px"><a href="${panel}/users/${r.userId}">${esc(r.name)}</a><br><span style="color:#64748b;font-size:12px">${esc(r.email)}${r.phone ? ' · ' + esc(r.phone) : ''}</span></td><td style="padding:4px 8px;font-size:13px">${why(r)}</td></tr>`).join('');
      const section = (title, list, why) => list.length ? `<h3 style="margin:18px 0 6px">${title} (${list.length})</h3><table style="border-collapse:collapse">${rows(list, why)}</table>${list.length > 10 ? `<p style="font-size:12px;color:#64748b">+${list.length - 10} more on the Sales page</p>` : ''}` : '';
      const html = `<p>Good morning. Here is who to contact today.</p>
        ${section('Follow-ups due', q.due, (r) => `due ${esc(String(r.nextFollowUp).slice(0, 10))} · ${esc(r.status)}`)}
        ${section('Deposited but never ordered', q.fundedNoOrder, (r) => `$${r.wallet} in wallet`)}
        ${section('New signups, no deposit yet', q.newSignups, (r) => `signed up ${new Date(r.signedUp).toDateString()}`)}
        ${section('Money sitting idle (30+ days)', q.idleWallets, (r) => `$${r.wallet} · last order ${new Date(r.lastOrder).toDateString()}`)}
        <p><a href="${panel}/sales">Open the Sales page</a></p>`;
      const admins = (await strapi.db.connection.raw(`select u.email from up_users u join up_users_role_lnk l on l.user_id = u.id join up_roles r on r.id = l.role_id
        where r.type in ('admin','super_admin') and not coalesce(u.blocked,false) and u.email like '%@%'`)).rows.map((r) => r.email);
      const to = process.env.SALES_DIGEST_TO ? process.env.SALES_DIGEST_TO.split(',').map((s) => s.trim()).filter(Boolean) : admins;
      if (!to.length) return;
      await strapi.service('api::admin-email.admin-email').sendAdminEmail({ to, subject: `Sales today: ${total} people to contact`, bodyHtml: html, senderAdminId: null, contextType: 'none' });
      console.log(`[Sales digest] sent to ${to.length} admin(s): ${total} leads`);
    },
    options: { rule: '30 3 * * *' }, // 09:00 IST
  },
};
