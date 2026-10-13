'use strict';

/**
 * GET /admin/system/health   (super admin)   2026-10-13
 *
 * One read-only snapshot of how the platform is doing: server load, memory,
 * disk, API process, database, background jobs, payment gateways, webhooks
 * and API errors in the last 24 h (from the nginx timing log).
 */
const os = require('os');
const fs = require('fs');

const LOG = '/var/log/nginx/timed.log';

function tail(file, bytes) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').slice(start > 0 ? 1 : 0);
  } catch { return []; }
}

module.exports = {
  async health(ctx) {
    const knex = strapi.db.connection;
    const now = Date.now();
    const mem = process.memoryUsage();
    let disk = null;
    try { const s = fs.statfsSync('/'); disk = { totalGb: +(s.blocks * s.bsize / 1e9).toFixed(1), freeGb: +(s.bavail * s.bsize / 1e9).toFixed(1) }; } catch { /* old node */ }

    const one = async (sql, b = []) => ((await knex.raw(sql, b)).rows || [])[0] || {};
    const many = async (sql, b = []) => (await knex.raw(sql, b)).rows || [];
    const [db, gateways, stuck] = await Promise.all([
      one(`select pg_database_size(current_database()) as bytes,
                  (select count(*) from pg_stat_activity where datname = current_database())::int as connections,
                  (select coalesce(max(extract(epoch from now() - query_start)), 0) from pg_stat_activity where datname = current_database() and state = 'active' and query not ilike '%pg_stat_activity%')::int as longest_query_s`),
      many(`select gateway,
                   max(created_at) filter (where transaction_status in ('success','completed','paid')) as last_success,
                   count(*) filter (where created_at > now() - interval '24 hours' and transaction_status in ('success','completed','paid'))::int as ok_24h,
                   count(*) filter (where created_at > now() - interval '24 hours' and transaction_status = 'failed')::int as failed_24h,
                   count(*) filter (where transaction_status = 'pending' and created_at < now() - interval '1 hour')::int as stuck_pending
              from transactions where type = 'deposit' and gateway in ('stripe','paypal','razorpay','bank_transfer')
             group by gateway order by gateway`),
      one(`select count(*)::int as n from orders where order_status = 'pending' and created_at < now() - interval '72 hours'`),
    ]);

    // nginx log: API 5xx and webhook deliveries in the last 24 h
    const since = new Date(now - 24 * 3600 * 1000).toISOString().slice(0, 19);
    // the log rotates daily (~00:10 UTC), so read yesterday's file too
    const lines = [...tail(`${LOG}.1`, 12 * 1024 * 1024), ...tail(LOG, 12 * 1024 * 1024)];
    let total = 0, s5 = 0, slow = 0;
    const errPaths = {}; const hooks = {};
    for (const l of lines) {
      const m = /^(\S+) (\S+) "(\S+) (\S+) [^"]*" (\d{3}) rt=([\d.]+)/.exec(l);
      if (!m) continue;
      if (m[1].slice(0, 19) < since) continue;
      if (m[3] === 'OPTIONS') continue;
      const path = m[4].split('?')[0]; const status = Number(m[5]); const rt = Number(m[6]);
      if (!path.startsWith('/api/')) continue;
      total += 1;
      if (rt > 3) slow += 1;
      if (status >= 500) { s5 += 1; const k = path.replace(/\/\d+(?=\/|$)/g, '/:id'); errPaths[k] = (errPaths[k] || 0) + 1; }
      if (/webhook/i.test(path)) { const h = hooks[path] || (hooks[path] = { path, count: 0, failed: 0, last: null, lastStatus: null }); h.count += 1; if (status >= 400) h.failed += 1; h.last = m[1]; h.lastStatus = status; }
    }

    const cron = Object.values(require('../../../cron/registry').runs || {});
    ctx.send({
      generatedAt: new Date().toISOString(),
      server: {
        loadavg: os.loadavg().map((x) => +x.toFixed(2)), cpus: os.cpus().length,
        memTotalGb: +(os.totalmem() / 1e9).toFixed(1), memFreeGb: +(os.freemem() / 1e9).toFixed(1),
        uptimeDays: +(os.uptime() / 86400).toFixed(1), disk,
      },
      api: { uptimeH: +(process.uptime() / 3600).toFixed(1), rssMb: Math.round(mem.rss / 1e6), heapMb: Math.round(mem.heapUsed / 1e6), node: process.version },
      database: { sizeMb: Math.round(Number(db.bytes || 0) / 1e6), connections: db.connections, longestQueryS: db.longest_query_s },
      traffic24h: { requests: total, errors5xx: s5, slowOver3s: slow, topErrors: Object.entries(errPaths).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([path, count]) => ({ path, count })) },
      webhooks: Object.values(hooks).sort((a, b) => b.count - a.count),
      gateways: gateways.map((g) => ({ gateway: g.gateway, lastSuccess: g.last_success, ok24h: g.ok_24h, failed24h: g.failed_24h, stuckPending: g.stuck_pending })),
      jobs: cron.sort((a, b) => a.name.localeCompare(b.name)),
      ordersPendingOver72h: stuck.n || 0,
    });
  },
};
