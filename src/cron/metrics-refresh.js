'use strict';

/**
 * Daily DR refresh (2026-10-13): every day at 05:00 UTC refresh the DR of the
 * 900 live listings with the oldest DR, using ONLY the free Ahrefs DR API
 * (0 cost; Apify is never called from here). ~26k live listings ÷ 900/day ≈
 * every listing once a month. Big jumps are held back for a human (same rule
 * as the External APIs page) and only ordinary changes are written.
 * Turn off with METRICS_AUTO_REFRESH=false; change size with METRICS_AUTO_REFRESH_LIMIT.
 */
module.exports = {
  metricsAutoRefresh: {
    task: async ({ strapi }) => {
      if (String(process.env.METRICS_AUTO_REFRESH || 'true') === 'false') return;
      const limit = Math.min(2000, Math.max(50, parseInt(process.env.METRICS_AUTO_REFRESH_LIMIT, 10) || 900));
      const { callController } = require('../api/admin/services/moderation');
      const admin = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { role: { type: 'super_admin' }, blocked: false }, populate: ['role'], orderBy: { id: 'asc' } });
      if (!admin) { console.warn('[Metrics auto-refresh] no super admin user; skipped'); return; }
      const result = await callController('api::admin.integrations', 'drRefresh', { id: 0, user: admin, body: { scope: 'stale', limit, provider: 'ahrefs', fresh: true } });
      const csv = result && result.csv;
      const rows = csv ? csv.trim().split('\n').length - 1 : 0;
      if (!rows) { console.log(`[Metrics auto-refresh] nothing to write (${(result && result.notes || []).join(' ') || 'no changes'})`); return; }
      await callController('api::admin.bulk-refresh', 'commit', { id: 0, user: admin, body: { tool: 'ahrefs', csv, filename: `dr-auto-${new Date().toISOString().slice(0, 10)}.csv`, label: `Daily DR refresh (${rows} listings, free Ahrefs API)` } });
      console.log(`[Metrics auto-refresh] committed ${rows} DR updates; held back for review: ${(result.review || []).length}`);
    },
    options: { rule: '0 5 * * *' },
  },
};
