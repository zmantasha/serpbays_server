'use strict';

/**
 * External APIs & MCP — super-admin integrations page + DR refresh.
 *
 *   GET  /admin/integrations                 status of every external service + usage
 *   POST /admin/integrations/:key/test       live re-check of one integration
 *   POST /admin/integrations/dr-refresh      fetch DR for a scope of listings and
 *                                            return a bulk-refresh PREVIEW + the CSV.
 *                                            Never writes: the panel commits the CSV
 *                                            through the existing audited
 *                                            /admin/marketplace/bulk-refresh/commit.
 *
 * DR provider chain (provider=auto):
 *   1. Ahrefs free public API (v3/public/domain-rating-free, 0 API units) — needs
 *      AHREFS_API_KEY. If it answers 401/403 the key is dead and we fall back.
 *   2. Apify actor datascraperes/bulk-domain-rating-checker ($0.0005 / domain,
 *      verified identical to Ahrefs DR on 20/20 domains 2026-09-28) — needs APIFY_TOKEN.
 * Every paid call is logged to admin_audit_logs (action 'integration_run').
 *
 * Keys (services/integration-keys.js): Ahrefs key and the Apify pool (primary +
 * up to 7 backups) are editable from the panel, encrypted at rest; the .env
 * values stay as fallback. Fetched DRs are cached 30 days (integration_dr_cache).
 *
 *   GET    /admin/integrations/keys              masked keys + open alerts
 *   POST   /admin/integrations/keys              add/replace (validated live first)
 *   PATCH  /admin/integrations/keys/:id          label / disable / make primary
 *   DELETE /admin/integrations/keys/:id
 *   POST   /admin/integrations/keys/:id/test
 *   POST   /admin/integrations/alerts/:id/resolve
 */

const fs = require('fs');
const keys = require('../services/integration-keys');

const AHREFS_DR_URL = 'https://api.ahrefs.com/v3/public/domain-rating-free';
const APIFY_DR_ACTOR = 'datascraperes~bulk-domain-rating-checker';
const APIFY_DR_COST = 0.0005;
const MAX_DOMAINS = 2000;
const BIG_CHANGE = 10;
const CHECK_TTL_MS = 5 * 60 * 1000;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function money(v) { return Math.round(n(v) * 10000) / 10000; }
function normDomain(s) {
  return String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
}

function requireSuperAdmin(ctx) {
  const t = ctx.state.user && ctx.state.user.role && ctx.state.user.role.type;
  if (t !== 'super_admin') { ctx.forbidden('Super admin only'); return false; }
  return true;
}

async function audit(ctx, action, details) {
  try {
    await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
      data: { adminUser: ctx.state.user.id, action, targetUser: null, details: details || {}, ipAddress: ctx.request.ip || null, userAgent: ctx.request.headers['user-agent'] || null, createdAt: new Date(), updatedAt: new Date() },
    });
  } catch (e) { strapi.log.warn(`[INTEGRATIONS] audit write failed: ${e.message}`); }
}

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    let body = null;
    const text = await r.text();
    try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: r.status, ok: r.ok, body };
  } finally { clearTimeout(t); }
}

// ───────────────────────── DR providers ─────────────────────────

async function ahrefsDr(domains) {
  const k = await keys.secretFor('ahrefs', 'AHREFS_API_KEY');
  if (!k) return { available: false, reason: 'no Ahrefs key set', results: {} };
  const key = k.secret;
  const results = {};
  let dead = null;
  let i = 0;
  const worker = async () => {
    while (i < domains.length && !dead) {
      const d = domains[i++];
      try {
        const r = await fetchJson(`${AHREFS_DR_URL}?target=${encodeURIComponent(d)}&output=json`, { headers: { Authorization: `Bearer ${key}` } }, 10000);
        if (r.status === 401 || r.status === 403) { dead = `Ahrefs answered ${r.status}`; return; }
        const v = r.ok && r.body && r.body.domain_rating && r.body.domain_rating.domain_rating;
        if (typeof v === 'number') results[d] = v;
      } catch (e) { /* per-domain failure → fallback handles it */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, domains.length) }, worker));
  if (dead) await keys.raiseAlert('ahrefs', 'key_invalid', k.id, `${dead}: the Ahrefs key (${k.source === 'env' ? 'server .env' : 'panel'}) was rejected. DR refresh fell back to Apify. Replace the key on the External APIs page.`);
  return { available: !dead, reason: dead, results };
}

async function apifyDr(domains) {
  const results = {};
  let cost = 0;
  let keyUsed = null;
  for (let k = 0; k < domains.length; k += 500) {
    const chunk = domains.slice(k, k + 500);
    const run = await keys.withApify(chunk.length * APIFY_DR_COST, (token, maxCharge) => fetchJson(
      `https://api.apify.com/v2/acts/${APIFY_DR_ACTOR}/run-sync-get-dataset-items?timeout=280&maxTotalChargeUsd=${maxCharge.toFixed(4)}`,
      { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ targets: chunk }) }, 300000));
    if (!run.ok) return { available: false, reason: run.reason, results, costUsd: money(cost), keyUsed };
    keyUsed = run.keyUsed;
    const r = run.result;
    if (!r.ok || !Array.isArray(r.body)) return { available: true, reason: `Apify run failed (${r.status})`, results, costUsd: money(cost), keyUsed };
    r.body.forEach((it) => { if (it && typeof it.domainRating === 'number') { results[normDomain(it.target)] = it.domainRating; cost += APIFY_DR_COST; } });
  }
  return { available: true, reason: null, results, costUsd: money(cost), keyUsed };
}

// ───────────────────────── status checks (cached) ─────────────────────────

const cache = new Map();
async function cached(key, fn, force) {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.value;
  let value;
  try { value = await fn(); } catch (e) { value = { state: 'error', detail: e.message }; }
  value.checkedAt = new Date().toISOString();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function readAppEnv(name) {
  try {
    const txt = fs.readFileSync('/var/www/serpbays-app/.env', 'utf8');
    const m = txt.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch (e) { return null; }
}

const CHECKS = {
  ahrefs: async () => {
    const k = await keys.secretFor('ahrefs', 'AHREFS_API_KEY');
    if (!k) return { state: 'missing', detail: 'No Ahrefs key. Add one below.' };
    const p = await keys.probe('ahrefs', k.secret);
    const src = k.source === 'env' ? 'server .env key' : 'panel key';
    return { state: p.status === 'ok' ? 'ok' : p.status, detail: `${p.detail} (${src})` };
  },
  apify: async () => {
    const pool = (await keys.apifyPool()).filter((k) => !k.disabled && k.secret);
    if (!pool.length) return { state: 'missing', detail: 'No Apify key. Add one below.' };
    const p = await keys.probe('apify', pool[0].secret);
    const backups = pool.filter((k) => k.slot > 0).length;
    const tail = ` · ${backups} backup key${backups === 1 ? '' : 's'}`;
    if (p.status === 'invalid') return { state: backups ? 'warn' : 'invalid', detail: `Primary token rejected by Apify.${backups ? ' A backup takes over on the next run.' : ''}${tail}` };
    return { state: p.status === 'ok' ? 'ok' : p.status === 'limit' ? 'warn' : p.status, detail: p.detail + tail, usage: p.usedUsd != null ? { usedUsd: p.usedUsd, limitUsd: p.limitUsd } : null };
  },
  clerk: async () => {
    const key = readAppEnv('CLERK_SECRET_KEY');
    if (!key) return { state: 'missing', detail: 'CLERK_SECRET_KEY not found in the customer app env.' };
    const r = await fetchJson('https://api.clerk.com/v1/users?limit=1', { headers: { Authorization: `Bearer ${key}` } }, 10000);
    if (r.ok) return { state: 'ok', detail: 'Secret key accepted by Clerk.' };
    if (r.status === 401 || r.status === 403) return { state: 'invalid', detail: 'Clerk rejects the secret key. Login still works (tokens are verified via JWKS), but server-side Clerk calls fail. Get a new key from dashboard.clerk.com → API Keys.' };
    return { state: 'error', detail: `Unexpected answer ${r.status}` };
  },
};

async function gatewayStats() {
  const r = await strapi.db.connection.raw(`select gateway, count(*) filter (where transaction_status in ('success','paid'))::int ok, count(*) filter (where transaction_status='failed')::int failed,
      max(created_at) filter (where transaction_status in ('success','paid')) last_ok
      from transactions where type='deposit' and gateway in ('stripe','paypal','razorpay','bank_transfer') and created_at > now() - interval '90 days' group by 1`);
  const out = {};
  (r.rows || r).forEach((x) => { out[x.gateway] = { ok: n(x.ok), failed: n(x.failed), lastOk: x.last_ok, successPct: n(x.ok) + n(x.failed) ? Math.round((n(x.ok) / (n(x.ok) + n(x.failed))) * 100) : null }; });
  return out;
}

function envState(...names) { return names.every((k) => !!process.env[k]) ? 'configured' : names.some((k) => !!process.env[k]) ? 'partial' : 'missing'; }

module.exports = {
  async list(ctx) {
    if (!requireSuperAdmin(ctx)) return;
    const force = ctx.query.refresh === '1';
    const knex = strapi.db.connection;
    const [ahrefs, apify, clerk, gw, runsR, geoR] = await Promise.all([
      cached('ahrefs', CHECKS.ahrefs, force), cached('apify', CHECKS.apify, force), cached('clerk', CHECKS.clerk, force), gatewayStats().catch(() => ({})),
      knex.raw(`select a.id, a.created_at, a.details, coalesce(u.username,'admin') admin from admin_audit_logs a left join admin_audit_logs_admin_user_lnk l on l.admin_audit_log_id=a.id left join up_users u on u.id=l.user_id where a.action='integration_run' order by a.created_at desc limit 30`),
      knex.raw(`select count(*) filter (where signup_country is not null)::int with_geo, max(last_login_at) last_login from up_users`),
    ]);
    const runs = (runsR.rows || runsR).map((r) => { const d = typeof r.details === 'string' ? JSON.parse(r.details) : (r.details || {}); return { id: r.id, at: r.created_at, admin: r.admin, ...d }; });
    const month = runs.filter((r) => new Date(r.at) > new Date(Date.now() - 30 * 86400000));
    const spend30 = money(month.reduce((a, r) => a + n(r.costUsd), 0));
    const geo = (geoR.rows || geoR)[0] || {};
    const gwItem = (key, label, envs) => ({ key, group: 'Payments', label, state: envState(...envs), detail: gw[key] ? `${gw[key].successPct == null ? '—' : gw[key].successPct + '%'} deposit success in 90 d · last success ${gw[key].lastOk ? new Date(gw[key].lastOk).toISOString().slice(0, 10) : 'never'}` : 'No deposits in 90 d', usedBy: 'Wallet deposits', cost: 'Per transaction (gateway fees)' });

    const [keyRows, alerts] = await Promise.all([keys.listKeys().catch(() => []), keys.openAlerts().catch(() => [])]);
    const panelKeys = keyRows.map(keys.publicKey);
    ctx.send({
      alerts,
      keys: {
        ahrefs: { panel: panelKeys.find((k) => k.provider === 'ahrefs') || null, envFallback: !!process.env.AHREFS_API_KEY },
        apify: { panel: panelKeys.filter((k) => k.provider === 'apify'), envFallback: !!process.env.APIFY_TOKEN, maxBackups: 7, budgetGuardPct: keys.BUDGET_GUARD * 100 },
      },
      integrations: [
        { key: 'ahrefs', group: 'SEO data', label: 'Ahrefs free DR API', state: ahrefs.state, detail: ahrefs.detail, checkedAt: ahrefs.checkedAt, usedBy: 'DR refresh (first choice)', cost: 'Free (0 API units)', endpoint: 'api.ahrefs.com/v3/public/domain-rating-free', env: 'AHREFS_API_KEY (or panel key)', testable: true, editable: true },
        { key: 'apify', group: 'SEO data', label: 'Apify', state: apify.state, detail: apify.detail, usage: apify.usage || null, checkedAt: apify.checkedAt, usedBy: 'DR refresh (fallback) · Ahrefs traffic / referring domains', cost: 'DR $0.0005 / domain · traffic $0.005 · ref. domains $0.015', endpoint: 'api.apify.com (actors: datascraperes/bulk-domain-rating-checker, scrapesage/ahrefs-scraper, pro100chok/ahrefs-seo-tools)', env: 'APIFY_TOKEN (or panel keys)', testable: true, editable: true },
        gwItem('stripe', 'Stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']),
        gwItem('paypal', 'PayPal', ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']),
        gwItem('razorpay', 'Razorpay', ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']),
        { key: 'clerk', group: 'Auth', label: 'Clerk (customer login)', state: clerk.state, detail: clerk.detail, checkedAt: clerk.checkedAt, usedBy: 'Customer sign-in, webhook sync', cost: 'Clerk plan', env: 'CLERK_SECRET_KEY (customer app)', testable: true },
        { key: 'cloudflare', group: 'Auth', label: 'Cloudflare geo (CF-IPCountry)', state: 'configured', detail: `${n(geo.with_geo)} users have a signup country · last login captured ${geo.last_login ? new Date(geo.last_login).toISOString().slice(0, 10) : 'never'}`, usedBy: 'Country flags on users', cost: 'Free' },
        { key: 'autosend', group: 'Email', label: 'AutoSend (transactional + lists)', state: envState('AUTOSEND_API_KEY'), detail: 'Templates and lists configured by env.', usedBy: 'Order, wallet, welcome, reset emails', cost: 'AutoSend plan', env: 'AUTOSEND_API_KEY' },
        { key: 'smtp', group: 'Email', label: 'SMTP', state: envState('SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD'), detail: process.env.SMTP_HOST ? `Host ${process.env.SMTP_HOST}` : 'Not configured', usedBy: 'Admin emails, email composer', cost: 'Mail provider plan', env: 'SMTP_*' },
        { key: 'redis', group: 'Infrastructure', label: 'Redis', state: envState('REDIS_URL'), detail: 'Realtime socket fan-out, locks', usedBy: 'Live admin updates, sync locks', cost: 'Self-hosted' },
      ],
      mcp: [
        { name: 'Apify MCP', where: 'Claude Code (operator laptop)', use: 'Run any Apify actor from chat: Ahrefs scrapers, Reddit, Google Maps, web fetch.' },
        { name: 'DataForSEO', where: 'Claude Code', use: 'Keyword volume, SERP, backlink reports. Paid per call; needs owner approval before use.' },
        { name: 'Google Search Console (service account)', where: 'Claude Code', use: 'Indexing and search performance for serpbays.com / saaslinks.net.' },
        { name: 'Serper.dev · SerpApi', where: 'Claude Code', use: 'Quick SERP rank checks, Google Trends.' },
        { name: 'Claude Docs · Gmail · Google Drive', where: 'Claude Code', use: 'Docs, email drafts, file access for reports.' },
      ],
      usage: { runs, spend30dUsd: spend30, runs30d: month.length },
      drRefresh: { maxDomains: MAX_DOMAINS, bigChange: BIG_CHANGE, apifyCostPerDomain: APIFY_DR_COST, cacheDays: keys.CACHE_DAYS },
    });
  },

  async test(ctx) {
    if (!requireSuperAdmin(ctx)) return;
    const key = ctx.params.key;
    if (!CHECKS[key]) return ctx.badRequest('Not a testable integration');
    ctx.send(await cached(key, CHECKS[key], true));
  },

  async drRefresh(ctx) {
    if (!requireSuperAdmin(ctx)) return;
    const started = Date.now();
    const body = ctx.request.body || {};
    const scope = ['top', 'stale', 'domains'].includes(body.scope) ? body.scope : 'top';
    const limit = Math.min(MAX_DOMAINS, Math.max(1, parseInt(body.limit, 10) || 20));
    const provider = ['auto', 'ahrefs', 'apify'].includes(body.provider) ? body.provider : 'auto';
    const knex = strapi.db.connection;

    let listings;
    if (scope === 'domains') {
      const doms = [...new Set((Array.isArray(body.domains) ? body.domains : String(body.domains || '').split(/[\s,]+/)).map(normDomain).filter(Boolean))].slice(0, MAX_DOMAINS);
      if (!doms.length) return ctx.badRequest('No domains given');
      listings = (await knex.raw(`select id, url, ahrefs_dr, rank_score, last_ahrefs_refresh_at from marketplaces where status='active' and lower(url) = any(?)`, [doms])).rows;
    } else if (scope === 'stale') {
      await keys.ensureTables();
      listings = (await knex.raw(`select m.id, m.url, m.ahrefs_dr, m.rank_score, m.last_ahrefs_refresh_at from marketplaces m
          left join integration_dr_cache c on c.domain = lower(m.url)
          where m.status='active'
          order by greatest(coalesce(m.last_ahrefs_refresh_at, m.last_metric_update_at, 'epoch'), coalesce(c.fetched_at, 'epoch')) asc, m.rank_score desc nulls last limit ?`, [limit])).rows;
    } else {
      listings = (await knex.raw(`select id, url, ahrefs_dr, rank_score, last_ahrefs_refresh_at from marketplaces where status='active' order by rank_score desc nulls last, id limit ?`, [limit])).rows;
    }
    const domains = [...new Set(listings.map((l) => normDomain(l.url)))];
    if (!domains.length) return ctx.send({ provider: null, fetched: 0, rows: [], review: [], csv: '', summary: null, notes: ['No active listings matched.'] });

    const notes = [];
    let results = {};
    let used = [];
    let cost = 0;
    let fromCache = 0;
    if (body.fresh !== true) {
      const c = await keys.cacheGet(domains).catch(() => ({}));
      Object.entries(c).forEach(([d, v]) => { results[d] = v.dr; });
      fromCache = Object.keys(c).length;
      if (fromCache) used.push('cache');
    }
    let todo = domains.filter((d) => results[d] === undefined);
    if (todo.length && provider !== 'apify') {
      const a = await ahrefsDr(todo);
      Object.assign(results, a.results);
      if (Object.keys(a.results).length) { used.push('ahrefs'); await keys.cachePut(a.results, 'ahrefs').catch(() => {}); }
      if (!a.available) notes.push(`Ahrefs free API unavailable: ${a.reason}.`);
    }
    todo = domains.filter((d) => results[d] === undefined);
    let apifyKey = null;
    if (todo.length && provider !== 'ahrefs') {
      const p = await apifyDr(todo);
      Object.assign(results, p.results);
      cost += p.costUsd;
      apifyKey = p.keyUsed;
      if (Object.keys(p.results).length) { used.push('apify'); await keys.cachePut(p.results, 'apify').catch(() => {}); }
      if (p.reason) notes.push(`Apify: ${p.reason}`);
      if (p.keyUsed && !/^primary/.test(p.keyUsed)) notes.push(`Apify ran on ${p.keyUsed} (primary key was rejected).`);
    }
    if (fromCache) notes.push(`${fromCache} domain${fromCache === 1 ? '' : 's'} answered from the ${keys.CACHE_DAYS}-day cache (no API call). Tick "Ignore cache" to re-fetch.`);

    const byUrl = new Map(listings.map((l) => [normDomain(l.url), l]));
    const rows = [], review = [], notFound = [];
    domains.forEach((d) => {
      const l = byUrl.get(d);
      const dr = results[d];
      if (dr === undefined) { notFound.push(d); return; }
      const old = l && l.ahrefs_dr != null ? n(l.ahrefs_dr) : null;
      const item = { url: l ? l.url : d, id: l && l.id, oldDr: old, newDr: dr, change: old == null ? null : Math.round((dr - old) * 100) / 100 };
      if (old != null && Math.abs(dr - old) >= BIG_CHANGE) review.push(item); else rows.push(item);
    });

    const includeBig = body.includeBigChanges === true;
    const csvRows = includeBig ? rows.concat(review) : rows;
    const csv = ['url,Domain Rating', ...csvRows.map((r) => `${r.url},${r.newDr}`)].join('\n');

    let preview = null;
    if (csvRows.length) {
      try {
        const svc = require('../services/bulk-refresh');
        preview = await svc.buildPreview({ tool: 'ahrefs', csvText: csv, csvFilename: 'dr-refresh.csv' });
      } catch (e) { notes.push(`Preview failed: ${e.message}`); }
    }

    await audit(ctx, 'integration_run', { integration: used.join('+') || 'none', purpose: 'dr-refresh-preview', scope, requested: domains.length, fetched: Object.keys(results).length, fromCache, apifyKey, costUsd: money(cost) });

    ctx.send({
      provider: used, scope, requested: domains.length, fetched: Object.keys(results).length, fromCache, costUsd: money(cost), tookMs: Date.now() - started,
      rows, review, notFound, includeBigChanges: includeBig,
      csv, summary: preview ? preview.summary : null,
      changes: preview ? (preview.rows || []).filter((r) => r.status === 'will-update').map((r) => ({ url: r.url, changes: r.changes })) : [],
      notes,
    });
  },

  // ───────────────────────── key management ─────────────────────────
  async keysList(ctx) {
    if (!requireSuperAdmin(ctx)) return;
    const [rowsK, alerts] = await Promise.all([keys.listKeys(), keys.openAlerts()]);
    ctx.send({ keys: rowsK.map(keys.publicKey), alerts, envFallback: { ahrefs: !!process.env.AHREFS_API_KEY, apify: !!process.env.APIFY_TOKEN } });
  },

  async keysCreate(ctx) {
    if (!requireSuperAdmin(ctx)) return;
    const b = ctx.request.body || {};
    try {
      const r = await keys.upsertKey({ provider: b.provider, slot: b.slot === 'backup' ? 'backup' : 0, label: b.label, secret: b.secret, adminId: ctx.state.user.id });
      cache.delete(b.provider);
      await audit(ctx, 'integration_key_change', { integration: b.provider, op: 'save', slot: r.slot, keyId: r.id, masked: keys.mask(String(b.secret || '').trim()), status: r.probe.status });
      ctx.send({ ok: true, id: r.id, slot: r.slot, status: r.probe.status, detail: r.probe.detail });
    } catch (e) {
      ctx.status = e.status || 400;
      ctx.body = { error: { status: ctx.status, message: e.message } };
    }
  },

  async keysUpdate(ctx) {
    if (!requireSuperAdmin(ctx)) return;
    const b = ctx.request.body || {};
    try {
      const k = await keys.updateKey(parseInt(ctx.params.id, 10), { label: b.label, disabled: b.disabled, makePrimary: b.makePrimary === true, adminId: ctx.state.user.id });
      cache.delete(k.provider);
      await audit(ctx, 'integration_key_change', { integration: k.provider, op: b.makePrimary ? 'make-primary' : b.disabled !== undefined ? (b.disabled ? 'disable' : 'enable') : 'rename', keyId: k.id, slot: k.slot, masked: `••••${k.last4}` });
      ctx.send({ ok: true, key: keys.publicKey(k) });
    } catch (e) { ctx.badRequest(e.message); }
  },

  async keysDelete(ctx) {
    if (!requireSuperAdmin(ctx)) return;
    try {
      const k = await keys.deleteKey(parseInt(ctx.params.id, 10));
      cache.delete(k.provider);
      await audit(ctx, 'integration_key_change', { integration: k.provider, op: 'delete', slot: k.slot, masked: `••••${k.last4}` });
      ctx.send({ ok: true });
    } catch (e) { ctx.badRequest(e.message); }
  },

  async keysTest(ctx) {
    if (!requireSuperAdmin(ctx)) return;
    try { ctx.send(await keys.testKey(parseInt(ctx.params.id, 10))); } catch (e) { ctx.badRequest(e.message); }
  },

  async alertResolve(ctx) {
    if (!requireSuperAdmin(ctx)) return;
    await keys.resolveAlerts(null, null, ctx.state.user.id, parseInt(ctx.params.id, 10));
    ctx.send({ ok: true });
  },
};
