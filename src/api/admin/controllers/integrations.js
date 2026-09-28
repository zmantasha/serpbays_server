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
 */

const fs = require('fs');

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
  const key = process.env.AHREFS_API_KEY;
  if (!key) return { available: false, reason: 'AHREFS_API_KEY not set', results: {} };
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
  return { available: !dead, reason: dead, results };
}

async function apifyDr(domains) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { available: false, reason: 'APIFY_TOKEN not set', results: {}, costUsd: 0 };
  const results = {};
  let cost = 0;
  for (let k = 0; k < domains.length; k += 500) {
    const chunk = domains.slice(k, k + 500);
    const r = await fetchJson(`https://api.apify.com/v2/acts/${APIFY_DR_ACTOR}/run-sync-get-dataset-items?timeout=280&maxTotalChargeUsd=${(chunk.length * APIFY_DR_COST + 0.01).toFixed(4)}`,
      { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ targets: chunk }) }, 300000);
    if (r.status === 401 || r.status === 403) return { available: false, reason: `Apify answered ${r.status}`, results, costUsd: cost };
    if (!r.ok || !Array.isArray(r.body)) return { available: true, reason: `Apify run failed (${r.status})`, results, costUsd: cost };
    r.body.forEach((it) => { if (it && typeof it.domainRating === 'number') { results[normDomain(it.target)] = it.domainRating; cost += APIFY_DR_COST; } });
  }
  return { available: true, reason: null, results, costUsd: money(cost) };
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
    if (!process.env.AHREFS_API_KEY) return { state: 'missing', detail: 'AHREFS_API_KEY is not set on the API server.' };
    const r = await fetchJson(`${AHREFS_DR_URL}?target=ahrefs.com&output=json`, { headers: { Authorization: `Bearer ${process.env.AHREFS_API_KEY}` } }, 10000);
    if (r.ok && r.body && r.body.domain_rating) return { state: 'ok', detail: `Answered: ahrefs.com DR ${r.body.domain_rating.domain_rating}` };
    if (r.status === 401 || r.status === 403) return { state: 'invalid', detail: `Ahrefs rejected the key (${r.status}). Create a new key at ahrefs.com → Account → API keys and update AHREFS_API_KEY. The same key is used by saaslinks.net's DR checker.` };
    return { state: 'error', detail: `Unexpected answer ${r.status}` };
  },
  apify: async () => {
    if (!process.env.APIFY_TOKEN) return { state: 'missing', detail: 'APIFY_TOKEN is not set on the API server.' };
    const h = { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` } };
    const [me, lim] = await Promise.all([fetchJson('https://api.apify.com/v2/users/me', h), fetchJson('https://api.apify.com/v2/users/me/limits', h)]);
    if (me.status === 401 || me.status === 403) return { state: 'invalid', detail: 'Apify rejected the token. Create a new one at console.apify.com → Settings → Integrations and update APIFY_TOKEN.' };
    const d = (me.body && me.body.data) || {};
    const l = (lim.body && lim.body.data) || {};
    const used = n(l.current && l.current.monthlyUsageUsd), cap = n(l.limits && l.limits.maxMonthlyUsageUsd);
    return { state: cap && used >= cap * 0.9 ? 'warn' : 'ok', detail: `Account ${d.username || '?'} · plan ${(d.plan && d.plan.id) || '?'}`, usage: { usedUsd: money(used), limitUsd: cap || null } };
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

    ctx.send({
      integrations: [
        { key: 'ahrefs', group: 'SEO data', label: 'Ahrefs free DR API', state: ahrefs.state, detail: ahrefs.detail, checkedAt: ahrefs.checkedAt, usedBy: 'DR refresh (first choice)', cost: 'Free (0 API units)', endpoint: 'api.ahrefs.com/v3/public/domain-rating-free', env: 'AHREFS_API_KEY', testable: true },
        { key: 'apify', group: 'SEO data', label: 'Apify', state: apify.state, detail: apify.detail, usage: apify.usage || null, checkedAt: apify.checkedAt, usedBy: 'DR refresh (fallback) · Ahrefs traffic / referring domains', cost: 'DR $0.0005 / domain · traffic $0.005 · ref. domains $0.015', endpoint: 'api.apify.com (actors: datascraperes/bulk-domain-rating-checker, scrapesage/ahrefs-scraper, pro100chok/ahrefs-seo-tools)', env: 'APIFY_TOKEN', testable: true },
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
      drRefresh: { maxDomains: MAX_DOMAINS, bigChange: BIG_CHANGE, apifyCostPerDomain: APIFY_DR_COST },
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
      listings = (await knex.raw(`select id, url, ahrefs_dr, rank_score, last_ahrefs_refresh_at from marketplaces where status='active' order by coalesce(last_ahrefs_refresh_at, last_metric_update_at, 'epoch') asc, rank_score desc nulls last limit ?`, [limit])).rows;
    } else {
      listings = (await knex.raw(`select id, url, ahrefs_dr, rank_score, last_ahrefs_refresh_at from marketplaces where status='active' order by rank_score desc nulls last, id limit ?`, [limit])).rows;
    }
    const domains = [...new Set(listings.map((l) => normDomain(l.url)))];
    if (!domains.length) return ctx.send({ provider: null, fetched: 0, rows: [], review: [], csv: '', summary: null, notes: ['No active listings matched.'] });

    const notes = [];
    let results = {};
    let used = [];
    let cost = 0;
    if (provider !== 'apify') {
      const a = await ahrefsDr(domains);
      Object.assign(results, a.results);
      if (Object.keys(a.results).length) used.push('ahrefs');
      if (!a.available) notes.push(`Ahrefs free API unavailable: ${a.reason}.`);
    }
    const missing = domains.filter((d) => results[d] === undefined);
    if (missing.length && provider !== 'ahrefs') {
      const p = await apifyDr(missing);
      Object.assign(results, p.results);
      cost += p.costUsd;
      if (Object.keys(p.results).length) used.push('apify');
      if (p.reason) notes.push(`Apify: ${p.reason}.`);
    }

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

    await audit(ctx, 'integration_run', { integration: used.join('+') || 'none', purpose: 'dr-refresh-preview', scope, requested: domains.length, fetched: Object.keys(results).length, costUsd: money(cost) });

    ctx.send({
      provider: used, scope, requested: domains.length, fetched: Object.keys(results).length, costUsd: money(cost), tookMs: Date.now() - started,
      rows, review, notFound, includeBigChanges: includeBig,
      csv, summary: preview ? preview.summary : null,
      changes: preview ? (preview.rows || []).filter((r) => r.status === 'will-update').map((r) => ({ url: r.url, changes: r.changes })) : [],
      notes,
    });
  },
};
