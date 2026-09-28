'use strict';

/**
 * Moderation service — one review layer over the existing approval paths.
 *
 * It does NOT re-implement approving: edits still go through
 * website-update-request approve/reject and new sites through
 * admin/websites approve/reject. This layer adds what the moderator needs to
 * decide fast and safely:
 *
 *   - normalised diff: real changes vs noise ("Lifetime"→"lifetime", null→0)
 *   - risk per changed field, peer price context, conflict detection
 *   - bulk groups (same publisher, same new values on many sites)
 *   - automatic checks for new sites (live, DR, traffic/country, duplicates,
 *     price, samples, publisher trust), cached in moderation_checks
 *   - claim locks, decision log, re-check flags after metric drops,
 *     settings (auto-approve rules, default OFF)
 *
 * Tables (created on first use): moderation_checks, moderation_decisions,
 * moderation_locks, moderation_flags, moderation_settings.
 */

const knex = () => strapi.db.connection;
const rows = (r) => r.rows || r;
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round = (v, d = 0) => { const p = 10 ** d; return Math.round(n(v) * p) / p; };

const LOCK_MINUTES = 10;
const CHECK_TTL_DAYS = 7;

// ───────────────────────── schema ─────────────────────────
let ready = null;
function ensureTables() {
  if (!ready) {
    ready = (async () => {
      await knex().raw(`create table if not exists moderation_checks (
        pw_id int not null, key text not null, status text not null, value jsonb, detail text, source text, cost_usd numeric default 0,
        ran_at timestamptz not null default now(), primary key (pw_id, key))`);
      await knex().raw(`create table if not exists moderation_decisions (
        id serial primary key, item_type text not null, item_id int not null, pw_id int, marketplace_id int, action text not null,
        reason_code text, note text, publisher_message text, checklist jsonb, snapshot jsonb, admin_id int, admin_name text,
        auto boolean not null default false, submitted_at timestamptz, created_at timestamptz not null default now())`);
      await knex().raw('create index if not exists moderation_decisions_created_idx on moderation_decisions (created_at)');
      await knex().raw(`create table if not exists moderation_locks (
        item_key text primary key, admin_id int not null, admin_name text, expires_at timestamptz not null)`);
      await knex().raw(`create table if not exists moderation_flags (
        id serial primary key, marketplace_id int not null, kind text not null, from_value numeric, to_value numeric, detail text,
        status text not null default 'open', created_at timestamptz not null default now(), resolved_at timestamptz, resolved_by int, resolution text,
        unique (marketplace_id, kind, status))`);
      await knex().raw(`create table if not exists moderation_dfs_traffic (domain text primary key, etv numeric, keywords int, raw jsonb, fetched_at timestamptz not null default now())`);
      await knex().raw(`create table if not exists moderation_spend (day date not null, provider text not null, usd numeric not null default 0, calls int not null default 0, primary key (day, provider))`);
      await knex().raw(`create table if not exists moderation_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now(), updated_by int)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ───────────────────────── field model ─────────────────────────
const PRICE_FIELDS = ['price', 'link_insertion_price', 'adv_casino_pricing', 'adv_li_casino_pricing', 'adv_crypto_pricing', 'adv_li_crypto_pricing',
  'adv_cbd_pricing', 'adv_li_cbd_pricing', 'adv_dating_pricing', 'adv_li_dating_pricing', 'publisher_writing_price'];
const NUMBER_FIELDS = new Set([...PRICE_FIELDS, 'tat', 'min_word_count']);
const ENUM_FIELDS = new Set(['backlink_type', 'backlink_validity', 'placement_speed']);
const LIST_FIELDS = new Set(['countries', 'language', 'category']);
const BOOL_FIELDS = new Set(['sponsored', 'ugc']);
const TEXT_PLACEHOLDERS = new Set(['no guidelines provided', 'n/a', 'na', 'none', '-']);

const LABELS = {
  price: 'Guest post price', link_insertion_price: 'Link insertion price',
  adv_casino_pricing: 'Casino guest post', adv_li_casino_pricing: 'Casino link insertion',
  adv_crypto_pricing: 'Crypto guest post', adv_li_crypto_pricing: 'Crypto link insertion',
  adv_cbd_pricing: 'CBD guest post', adv_li_cbd_pricing: 'CBD link insertion',
  adv_dating_pricing: 'Dating guest post', adv_li_dating_pricing: 'Dating link insertion',
  publisher_writing_price: 'Copywriting price', tat: 'TAT (days)', min_word_count: 'Min word count',
  backlink_type: 'Backlink type', backlink_validity: 'Backlink validity', placement_speed: 'Placement speed',
  countries: 'Countries', language: 'Language', category: 'Category', guidelines: 'Guidelines', description: 'Description',
  publication_location: 'Publication location', sponsored: 'Sponsored tag', ugc: 'UGC tag',
};

const VALIDITY_RANK = { one_year: 1, three_years: 3, five_years: 5, lifetime: 99 };
function normEnum(v) {
  if (v == null) return '';
  const s = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ({ '1_year': 'one_year', '1_years': 'one_year', '3_year': 'three_years', '3_years': 'three_years', '5_year': 'five_years', '5_years': 'five_years', life_time: 'lifetime', permanent: 'lifetime', do_follow: 'dofollow', no_follow: 'nofollow' })[s] || s;
}
function parseList(v) {
  if (v == null || v === '') return [];
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch (e) { a = v.split(','); } }
  if (!Array.isArray(a)) a = [a];
  return a.map((x) => String(x).trim()).filter(Boolean);
}
/** Canonical form used to decide whether a value really changed. */
function norm(field, v) {
  if (NUMBER_FIELDS.has(field)) return v == null || v === '' ? 0 : n(v);
  if (ENUM_FIELDS.has(field)) return normEnum(v);
  if (LIST_FIELDS.has(field)) return JSON.stringify(parseList(v).map((x) => x.toLowerCase()).sort());
  if (BOOL_FIELDS.has(field)) return !!v && v !== 'false';
  const s = v == null ? '' : String(v).trim().replace(/\s+/g, ' ');
  return TEXT_PLACEHOLDERS.has(s.toLowerCase()) ? '' : s;
}
function display(field, v) {
  if (LIST_FIELDS.has(field)) { const a = parseList(v); return a.length ? a.join(', ') : '—'; }
  if (BOOL_FIELDS.has(field)) return v ? 'Yes' : 'No';
  if (v == null || v === '') return '—';
  return String(v);
}

/** Risk of one real change → { level: low|medium|high, why }. */
function fieldRisk(field, from, to, ctx = {}) {
  if (PRICE_FIELDS.includes(field)) {
    const a = n(from), b = n(to);
    if (a === 0 && b > 0) return { level: 'medium', why: 'newly offered' };
    if (b === 0) return { level: 'low', why: 'no longer offered' };
    const pct = a ? ((b - a) / a) * 100 : 0;
    const peer = ctx.peerMedian && field === 'price' ? ctx.peerMedian : null;
    if (peer && b > peer * 3) return { level: 'high', why: `${round(b / peer, 1)}× the peer median $${round(peer)}` };
    if (pct > 50) return { level: 'high', why: `+${round(pct)}%` };
    if (pct > 20) return { level: 'medium', why: `+${round(pct)}%` };
    if (pct < -70) return { level: 'medium', why: `${round(pct)}% (unusually large cut)` };
    return { level: 'low', why: `${pct > 0 ? '+' : ''}${round(pct)}%` };
  }
  if (field === 'backlink_type') return normEnum(to) === 'nofollow' ? { level: 'high', why: 'links become nofollow' } : { level: 'medium', why: 'link type changed' };
  if (field === 'backlink_validity') {
    const a = VALIDITY_RANK[normEnum(from)] || 0, b = VALIDITY_RANK[normEnum(to)] || 0;
    return b < a ? { level: 'high', why: 'links kept for a shorter time' } : { level: 'low', why: 'longer or same validity' };
  }
  if (field === 'sponsored' || field === 'ugc') return to ? { level: 'high', why: 'links get a sponsored/UGC tag' } : { level: 'medium', why: 'tag removed' };
  if (field === 'category' || field === 'countries' || field === 'language') return { level: 'medium', why: 'changes where the listing shows up' };
  if (field === 'placement_speed') return { level: 'low', why: 'follows TAT' };
  return { level: 'low', why: 'listing detail' };
}
const LEVEL = { low: 1, medium: 2, high: 3 };
const maxLevel = (items) => items.reduce((m, x) => (LEVEL[x.risk.level] > LEVEL[m] ? x.risk.level : m), 'low');

// ───────────────────────── context helpers ─────────────────────────
const trafficBand = (t) => (t == null ? 0 : t < 1000 ? 1 : t < 10000 ? 2 : t < 100000 ? 3 : 4);
let peerCache = { at: 0, map: new Map() };
/** Median guest-post price of active listings in the same DR decade × traffic band. */
async function peerMedian(dr, traffic) {
  if (Date.now() - peerCache.at > 3600 * 1000) {
    const r = rows(await knex().raw(`select least(floor(coalesce(ahrefs_dr,0)/10),9)::int drb,
        case when ahrefs_traffic is null then 0 when ahrefs_traffic<1000 then 1 when ahrefs_traffic<10000 then 2 when ahrefs_traffic<100000 then 3 else 4 end tb,
        percentile_cont(0.5) within group (order by price) med, count(*)::int c
      from marketplaces where status='active' and price > 0 group by 1,2`));
    const map = new Map();
    r.forEach((x) => map.set(`${x.drb}:${x.tb}`, { median: round(x.med), count: x.c }));
    peerCache = { at: Date.now(), map };
  }
  const k = `${Math.min(9, Math.floor(n(dr) / 10))}:${trafficBand(traffic == null ? null : n(traffic))}`;
  const v = peerCache.map.get(k);
  return v && v.count >= 5 ? v : null;
}

const trustCache = new Map();
/** Explainable 0–100 publisher trust score. */
async function publisherTrust(userId) {
  if (!userId) return null;
  const hit = trustCache.get(userId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const r = rows(await knex().raw(`select
      (select created_at from up_users where id=?) created_at,
      (select count(*)::int from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where l.user_id=?) sites,
      (select count(*)::int from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where l.user_id=? and p.submission_status='approved') approved,
      (select count(*)::int from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where l.user_id=? and p.submission_status='rejected') rejected,
      (select count(*)::int from orders o join orders_publisher_lnk l on l.order_id=o.id where l.user_id=? and o.order_status='completed') completed,
      (select count(*)::int from orders o join orders_publisher_lnk l on l.order_id=o.id where l.user_id=? and (o.order_status in ('disputed') or o.dispute_date is not null)) disputes,
      (select count(*)::int from orders o join orders_publisher_lnk l on l.order_id=o.id where l.user_id=? and o.order_status in ('rejected','cancelled')) lost,
      (select count(*)::int from moderation_decisions d where d.action in ('reject','ask_changes') and d.pw_id in (select publisher_website_id from publisher_websites_current_publisher_id_lnk where user_id=?) and d.created_at > now() - interval '180 days') mod_rejects`,
  [userId, userId, userId, userId, userId, userId, userId, userId]))[0] || {};
  const ageDays = r.created_at ? (Date.now() - new Date(r.created_at).getTime()) / 86400000 : 0;
  const parts = [];
  let score = 50;
  const add = (pts, label) => { if (pts) { score += pts; parts.push(`${pts > 0 ? '+' : ''}${pts} ${label}`); } };
  add(Math.min(20, n(r.completed) * 2), `${r.completed} completed orders`);
  add(-Math.min(30, n(r.disputes) * 10), `${r.disputes} disputes`);
  add(-Math.min(15, n(r.lost) * 3), `${r.lost} rejected/cancelled orders`);
  add(ageDays > 90 ? 10 : ageDays < 14 ? -10 : 0, ageDays > 90 ? 'account older than 90 days' : ageDays < 14 ? 'account younger than 14 days' : '');
  const rejRatio = n(r.sites) ? n(r.rejected) / n(r.sites) : 0;
  add(rejRatio > 0.3 ? -15 : 0, `${round(rejRatio * 100)}% of sites rejected`);
  add(-Math.min(20, n(r.mod_rejects) * 4), `${r.mod_rejects} moderation rejections in 180 d`);
  const value = { score: Math.max(0, Math.min(100, score)), parts, sites: n(r.sites), approved: n(r.approved), rejected: n(r.rejected), completedOrders: n(r.completed), disputes: n(r.disputes), accountAgeDays: Math.round(ageDays) };
  trustCache.set(userId, { at: Date.now(), value });
  return value;
}

// ───────────────────────── edits ─────────────────────────
/** All pending edit requests, normalised, with risk, context and groups. */
async function listEdits() {
  await ensureTables();
  const reqs = rows(await knex().raw(`select w.id, w.changes, w.base_snapshot, w.submitted_by, w.submitted_at, w.created_at,
      m.id mid, coalesce(m.url, pwx.url, '#' || w.id || ' (no listing linked)') url, coalesce(m.status, case when m.id is null then 'missing' end) mstatus, m.ahrefs_dr, m.ahrefs_traffic, m.ahrefs_top_country, m.price mprice, m.rank_score, to_jsonb(m) mrow,
      pl.publisher_website_id pw_id, pu.user_id publisher_id, u.username publisher_username, coalesce(nullif(u.business_name,''), nullif(u.first_name,''), u.username) publisher_name
    from website_update_requests w
    left join website_update_requests_marketplace_lnk ml on ml.website_update_request_id=w.id left join marketplaces m on m.id=ml.marketplace_id
    left join website_update_requests_publisher_website_lnk pl on pl.website_update_request_id=w.id
    left join publisher_websites pwx on pwx.id=pl.publisher_website_id
    left join publisher_websites_current_publisher_id_lnk pu on pu.publisher_website_id=pl.publisher_website_id
    left join up_users u on u.id=pu.user_id
    where w.status='pending' order by w.created_at asc`));
  const ids = reqs.map((r) => r.mid).filter(Boolean);
  const ctxRows = ids.length ? rows(await knex().raw(`select m.id,
      (select count(*)::int from orders o join orders_website_lnk l on l.order_id=o.id where l.marketplace_id=m.id and o.order_status in ('pending','accepted','delivered','revision_requested','in_progress')) open_orders,
      (select count(*)::int from orders o join orders_website_lnk l on l.order_id=o.id where l.marketplace_id=m.id and o.order_status='completed') done_orders,
      (select count(*)::int from shortlists_marketplace_lnk s where s.marketplace_id=m.id) shortlisted
    from marketplaces m where m.id = any(?)`, [ids])) : [];
  const ctxBy = new Map(ctxRows.map((c) => [c.id, c]));
  const superseded = rows(await knex().raw(`select ml.marketplace_id mid, count(*)::int c from website_update_requests w join website_update_requests_marketplace_lnk ml on ml.website_update_request_id=w.id
      where w.status='superseded' and w.created_at > now() - interval '30 days' and ml.marketplace_id = any(?) group by 1`, [ids.length ? ids : [0]]));
  const supBy = new Map(superseded.map((s) => [s.mid, s.c]));

  const items = [];
  for (const r of reqs) {
    const changes = typeof r.changes === 'string' ? JSON.parse(r.changes) : (r.changes || {});
    const base = typeof r.base_snapshot === 'string' ? JSON.parse(r.base_snapshot) : (r.base_snapshot || {});
    const live = typeof r.mrow === 'string' ? JSON.parse(r.mrow) : (r.mrow || {});
    const peer = await peerMedian(r.ahrefs_dr, r.ahrefs_traffic);
    const real = [], noise = [], conflicts = [];
    const tatChanged = 'tat' in changes && norm('tat', base.tat) !== norm('tat', changes.tat);
    for (const [field, to] of Object.entries(changes)) {
      const from = base[field];
      if (norm(field, from) === norm(field, to) || (field === 'placement_speed' && !tatChanged)) {
        noise.push({ field, label: LABELS[field] || field, from: display(field, from), to: display(field, to) });
        continue;
      }
      const item = { field, label: LABELS[field] || field, from: display(field, from), to: display(field, to), fromRaw: from ?? null, toRaw: to ?? null, risk: fieldRisk(field, from, to, { peerMedian: peer && peer.median }) };
      if (PRICE_FIELDS.includes(field) && n(from) && n(to)) item.pct = round(((n(to) - n(from)) / n(from)) * 100);
      if (field in live && norm(field, live[field]) !== norm(field, from)) {
        conflicts.push({ field, label: item.label, snapshot: display(field, from), now: display(field, live[field]) });
        item.conflict = true;
      }
      real.push(item);
    }
    const c = ctxBy.get(r.mid) || {};
    const risk = real.length ? maxLevel(real) : 'none';
    const groupKey = real.length ? `${r.publisher_id || r.submitted_by}|${JSON.stringify(real.map((x) => [x.field, norm(x.field, x.toRaw)]).sort())}` : null;
    const ageH = (Date.now() - new Date(r.created_at).getTime()) / 3600000;
    const trust = await publisherTrust(r.publisher_id);
    items.push({
      id: r.id, key: `edit:${r.id}`, marketplaceId: r.mid, pwId: r.pw_id, url: r.url, listingStatus: r.mstatus,
      submittedBy: r.submitted_by, submittedAt: r.submitted_at || r.created_at, ageHours: round(ageH, 1),
      publisher: { id: r.publisher_id, name: r.publisher_name, username: r.publisher_username, trust },
      metrics: { dr: r.ahrefs_dr != null ? n(r.ahrefs_dr) : null, traffic: r.ahrefs_traffic != null ? n(r.ahrefs_traffic) : null, topCountry: r.ahrefs_top_country || null, rankScore: r.rank_score != null ? round(r.rank_score, 1) : null },
      real, noise, conflicts, risk, groupKey,
      summary: real.length ? real.slice(0, 3).map((x) => `${x.label} ${x.from} → ${x.to}`).join(' · ') + (real.length > 3 ? ` · +${real.length - 3} more` : '') : 'No real change',
      context: { peerMedian: peer ? peer.median : null, peerCount: peer ? peer.count : 0, openOrders: n(c.open_orders), completedOrders: n(c.done_orders), shortlisted: n(c.shortlisted), resubmits30d: supBy.get(r.mid) || 0 },
      sla: { dueHours: 24, overdue: ageH > 24 },
      priority: round((LEVEL[risk] || 0) * 20 + Math.min(40, ageH) + Math.min(20, n(r.rank_score) / 5) + (trust && trust.score < 40 ? 10 : 0), 1),
    });
  }
  const groups = new Map();
  items.forEach((it) => { if (it.groupKey) { if (!groups.has(it.groupKey)) groups.set(it.groupKey, []); groups.get(it.groupKey).push(it.id); } });
  items.forEach((it) => { const g = it.groupKey && groups.get(it.groupKey); it.group = g && g.length > 1 ? { key: it.groupKey, ids: g, size: g.length } : null; });
  return items;
}

// ───────────────────────── new-site checks ─────────────────────────
const canon = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
// Punycode form, so 'робибізнес.укр' and 'xn--90aamhd6acpq0s.xn--j1amh' compare equal.
const ascii = (d) => { try { return require('url').domainToASCII(d) || d; } catch (e) { return d; } };
const COUNTRY_ALIASES = { usa: 'united states', us: 'united states', 'united states of america': 'united states', america: 'united states', uk: 'united kingdom', 'great britain': 'united kingdom', england: 'united kingdom', uae: 'united arab emirates' };
const cname = (s) => { const x = String(s || '').trim().toLowerCase().replace(/^the\s+/, ''); return COUNTRY_ALIASES[x] || x; };
const PARKED = /(domain (is )?for sale|buy this domain|parked (free|domain)|this domain may be for sale|sedo\.com|dan\.com\/buy|afternic)/i;

async function fetchPage(url, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; SerpbaysModeration/1.0; +https://serpbays.com)' } });
    const body = (await r.text()).slice(0, 200000);
    return { status: r.status, finalUrl: r.url, body };
  } catch (e) { return { status: 0, error: e.name === 'AbortError' ? 'timed out' : e.message }; }
  finally { clearTimeout(t); }
}

// ───────────────────────── traffic: Ahrefs first, DataForSEO fallback ─────────────────────────
const DFS_DAILY_CAP_USD = 2; // ~160 calls ≈ 16k domains; protects against a runaway loop
const DFS_CALL_USD = 0.0122;
async function spendToday(provider) {
  const r = rows(await knex().raw('select usd from moderation_spend where day=current_date and provider=?', [provider]))[0];
  return r ? n(r.usd) : 0;
}
async function addSpend(provider, usd) {
  await knex().raw(`insert into moderation_spend (day, provider, usd, calls) values (current_date, ?, ?, 1)
      on conflict (day, provider) do update set usd = moderation_spend.usd + excluded.usd, calls = moderation_spend.calls + 1`, [provider, usd]);
}

function parseAhrefsTop(d) {
  const month = String(d.dataMonth || '');
  let t = !/1970/.test(month) && typeof d.organicTraffic === 'number' ? d.organicTraffic : null;
  if (t == null && typeof d.siteDescription === 'string') {
    const m = d.siteDescription.match(/with ([\d.]+)\s*([KMB]?) traffic in/);
    if (m) t = Math.round(Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, B: 1e9 })[m[2]]);
  }
  return {
    traffic: t, keywords: !/1970/.test(month) && typeof d.organicKeywords === 'number' ? d.organicKeywords : null,
    topCountry: typeof d.topCountry === 'string' ? d.topCountry.replace(/^the\s+/i, '') : null,
    share: typeof d.topCountryShare === 'number' ? round(d.topCountryShare * 100, 1) : null,
    value: typeof d.trafficValueUsd === 'number' ? d.trafficValueUsd : null, month: /1970/.test(month) ? null : month,
  };
}

/**
 * Organic traffic for many domains. Order: 30-day caches → Apify Ahrefs Top-Websites
 * ($0.005 per tracked domain, budget-guarded) → DataForSEO bulk_traffic_estimation
 * ($0.012 per 100 domains) for domains Ahrefs does not track or when Apify is paused.
 * Returns domain → { source: 'ahrefs'|'dataforseo', traffic, keywords, topCountry?, share?, note }.
 */
async function fetchTraffic(domains, opts = {}) {
  await ensureTables();
  const keys = require('./integration-keys');
  const out = {};
  const uniq = [...new Set(domains.map(canon).filter(Boolean))];
  const raw = await keys.rawGet(uniq).catch(() => ({}));
  let needAhrefs = [];
  const needDfs = new Set();
  uniq.forEach((d) => {
    const r = raw[d];
    if (r && r.tracked && r.data) out[d] = { source: 'ahrefs', ...parseAhrefsTop(r.data) };
    else if (r && !r.tracked) needDfs.add(d);
    else needAhrefs.push(d);
  });
  let apifyNote = null;
  if (opts.paid && needAhrefs.length) {
    const chunks = [];
    for (let i = 0; i < needAhrefs.length; i += 50) chunks.push(needAhrefs.slice(i, i + 50));
    let stop = false;
    for (let g = 0; g < chunks.length && !stop; g += 4) {
      await Promise.all(chunks.slice(g, g + 4).map(async (chunk) => {
        if (stop) { chunk.forEach((d) => needDfs.add(d)); return; }
        const run = await keys.withApify(chunk.length * 0.005, (token, maxCharge) => apifyRun(token, maxCharge,
          { domains: chunk, includeHistory: false, includeKeywords: false, includeCountries: true, includeCompetitors: false, maxItems: chunk.length })).catch((e) => ({ ok: false, reason: e.message }));
        if (!run.ok || !Array.isArray(run.result && run.result.body)) { stop = true; apifyNote = run.reason || 'Apify run failed'; chunk.forEach((d) => needDfs.add(d)); return; }
        const got = new Map(run.result.body.filter((x) => x && x.domain).map((x) => [canon(x.domain), x]));
        await keys.rawPut(chunk.map((d) => ({ domain: d, tracked: got.has(d), data: got.get(d) || null }))).catch(() => {});
        chunk.forEach((d) => { const it = got.get(d); if (it) out[d] = { source: 'ahrefs', ...parseAhrefsTop(it) }; else needDfs.add(d); });
      }));
    }
    needAhrefs = [];
  }
  // DataForSEO fallback (cache first)
  const dfsList = [...needDfs];
  if (dfsList.length) {
    const cached = rows(await knex().raw(`select domain, etv, keywords from moderation_dfs_traffic where domain = any(?) and fetched_at > now() - interval '30 days'`, [dfsList]));
    const have = new Set();
    cached.forEach((c) => { have.add(c.domain); out[c.domain] = { source: 'dataforseo', traffic: Math.round(n(c.etv)), keywords: c.keywords != null ? n(c.keywords) : null }; });
    const missing = dfsList.filter((d) => !have.has(d));
    if (opts.paid && missing.length && process.env.DATAFORSEO_AUTH) {
      for (let i = 0; i < missing.length; i += 100) {
        if ((await spendToday('dataforseo')) + DFS_CALL_USD > DFS_DAILY_CAP_USD) { strapi.log.warn('[MODERATION] DataForSEO daily cap reached'); break; }
        const chunk = missing.slice(i, i + 100);
        try {
          const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60000);
          const r = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_traffic_estimation/live', {
            // IDN domains must be sent in punycode ('отзывы.укр' → 0, 'xn--b1ajuq0cb.xn--j1amh' → 2,800).
            method: 'POST', signal: ac.signal, headers: { Authorization: `Basic ${process.env.DATAFORSEO_AUTH}`, 'content-type': 'application/json' }, body: JSON.stringify([{ targets: chunk.map(ascii) }]) });
          clearTimeout(t);
          const j = await r.json();
          await addSpend('dataforseo', n(j.cost) || DFS_CALL_USD);
          const items = ((((j.tasks || [])[0] || {}).result || [])[0] || {}).items || [];
          const got = new Map(items.map((it) => [ascii(canon(it.target)), it]));
          const vals = chunk.map((d) => { const m = ((got.get(ascii(d)) || {}).metrics || {}).organic || {}; return { d, etv: n(m.etv), kw: m.count != null ? n(m.count) : null, raw: got.get(ascii(d)) || null }; });
          await knex().raw(`insert into moderation_dfs_traffic (domain, etv, keywords, raw, fetched_at) values ${vals.map(() => '(?,?,?,?::jsonb,now())').join(',')}
              on conflict (domain) do update set etv=excluded.etv, keywords=excluded.keywords, raw=excluded.raw, fetched_at=now()`, vals.flatMap((v) => [v.d, v.etv, v.kw, JSON.stringify(v.raw)]));
          vals.forEach((v) => { out[v.d] = { source: 'dataforseo', traffic: Math.round(v.etv), keywords: v.kw }; });
        } catch (e) { strapi.log.warn(`[MODERATION] DataForSEO traffic failed: ${e.message}`); break; }
      }
    }
  }
  return { byDomain: out, apifyNote };
}

/** Start → poll → read dataset (run-sync once lost paid results on a 502). */
async function apifyRun(token, maxCharge, input) {
  const auth = { Authorization: `Bearer ${token}` };
  const j = async (url, opts) => { const r = await fetch(url, opts); const b = await r.json().catch(() => null); return { status: r.status, ok: r.ok, body: b }; };
  const start = await j(`https://api.apify.com/v2/acts/scrapesage~ahrefs-scraper/runs?timeout=120&waitForFinish=60&maxTotalChargeUsd=${maxCharge.toFixed(4)}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(input) });
  if (!start.ok || !start.body || !start.body.data) return { status: start.status, ok: false, body: null };
  let run = start.body.data;
  const until = Date.now() + 180000;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status) && Date.now() < until) {
    const r = await j(`https://api.apify.com/v2/actor-runs/${run.id}?waitForFinish=60`, { headers: auth });
    if (r.ok && r.body && r.body.data) run = r.body.data;
  }
  const items = await j(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=true&format=json`, { headers: auth });
  return { status: Array.isArray(items.body) ? 200 : 502, ok: Array.isArray(items.body), body: Array.isArray(items.body) ? items.body : null };
}

async function saveCheck(pwId, key, status, value, detail, source, cost = 0) {
  await knex().raw(`insert into moderation_checks (pw_id, key, status, value, detail, source, cost_usd, ran_at) values (?,?,?,?::jsonb,?,?,?,now())
      on conflict (pw_id, key) do update set status=excluded.status, value=excluded.value, detail=excluded.detail, source=excluded.source, cost_usd=excluded.cost_usd, ran_at=now()`,
  [pwId, key, status, JSON.stringify(value == null ? null : value), detail, source, cost]);
}

/**
 * Run every automatic check for one publisher website and store the results.
 * opts.paid=true allows one Apify traffic lookup ($0.005, budget-guarded) when
 * the domain is not in the 30-day cache.
 */
async function runSiteChecks(pwId, opts = {}) {
  await ensureTables();
  const pw = rows(await knex().raw(`select p.*, l.user_id publisher_id from publisher_websites p left join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where p.id=?`, [pwId]))[0];
  if (!pw) throw Object.assign(new Error('Website not found'), { status: 404 });
  const domain = canon(pw.url);
  const keys = require('./integration-keys');
  const out = {};
  const put = async (key, status, value, detail, source, cost) => { out[key] = { status, value, detail, source }; await saveCheck(pwId, key, status, value, detail, source, cost); };

  // 1. Ownership
  if (pw.gsc_verified) await put('ownership', 'ok', { method: 'gsc' }, 'Verified with Google Search Console', 'publisher');
  else if (pw.submission_status === 'pending_verification') await put('ownership', 'fail', { method: pw.verification_method }, 'Ownership not verified yet', 'publisher');
  else if (pw.verification_method === 'reseller-code' || pw.added_by_reseller) await put('ownership', 'warn', { method: 'reseller-code', code: pw.reseller_code }, `Added by a reseller (code ${pw.reseller_code || '—'}): no owner proof`, 'publisher');
  else await put('ownership', 'warn', { method: pw.verification_method || null }, `Verification: ${pw.verification_method || 'none recorded'}`, 'publisher');

  // 2. Site is live
  const page = await fetchPage(`${pw.protocol === 'http' ? 'http' : 'https'}://${domain}/`);
  if (!page.status) await put('live', 'fail', { error: page.error }, `Site did not load (${page.error})`, 'fetch');
  else {
    const finalHost = ascii(canon(page.finalUrl));
    const host = ascii(domain);
    const sameSite = finalHost === host || finalHost.endsWith(`.${host}`) || host.endsWith(`.${finalHost}`);
    if (page.status >= 400) await put('live', 'fail', { status: page.status }, `Site answers HTTP ${page.status}`, 'fetch');
    else if (PARKED.test(page.body)) await put('live', 'fail', { status: page.status, parked: true }, 'Looks like a parked / for-sale domain', 'fetch');
    else if (!sameSite) await put('live', 'warn', { status: page.status, redirectsTo: finalHost }, `Redirects to another domain: ${finalHost}`, 'fetch');
    else {
      const lang = (page.body.match(/<html[^>]*\slang=["']?([a-zA-Z-]{2,10})/i) || [])[1] || null;
      const title = ((page.body.match(/<title[^>]*>([^<]{0,160})/i) || [])[1] || '').trim()
        .replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, c) => String.fromCharCode(Number(c)));
      await put('live', 'ok', { status: page.status, https: String(page.finalUrl).startsWith('https'), lang, title }, `Live (HTTP ${page.status})${title ? ` · “${title.slice(0, 60)}”` : ''}`, 'fetch');
    }
  }

  // 2b. Content signals from the homepage we just loaded
  if (page.status && page.status < 400 && page.body) {
    const text = page.body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
    const words = text.split(' ').filter((w) => w.length > 1).length;
    const low = text.toLowerCase();
    const count = (re) => (low.match(re) || []).length;
    const gambling = count(/\b(casino|betting|sportsbook|slots?|poker|jackpot|togel|judi)\b/g);
    const adult = count(/\b(porn|xxx|escort|nude|sex cam|onlyfans)\b/g);
    const pharma = count(/\b(viagra|cialis|kamagra|cbd gummies)\b/g);
    const linkSelling = count(/\b(write for us|guest post|sponsored post|submit (a )?guest|advertise with us)\b/g);
    const outLinks = (page.body.match(/<a\s[^>]*href=["']https?:\/\//gi) || []).length;
    const lang = (page.body.match(/<html[^>]*\slang=["']?([a-zA-Z-]{2,10})/i) || [])[1] || null;
    const declaredLang = parseList(pw.language).map((x) => x.toLowerCase());
    const LANG = { en: 'english', de: 'german', fr: 'french', es: 'spanish', it: 'italian', pt: 'portuguese', nl: 'dutch', ru: 'russian', uk: 'ukrainian', pl: 'polish', tr: 'turkish', ar: 'arabic', hi: 'hindi', id: 'indonesian', ro: 'romanian', cs: 'czech', hu: 'hungarian', sv: 'swedish', da: 'danish', fi: 'finnish', no: 'norwegian', el: 'greek', bg: 'bulgarian', hr: 'croatian', sr: 'serbian', ja: 'japanese', ko: 'korean', zh: 'chinese', vi: 'vietnamese', th: 'thai', he: 'hebrew' };
    const langName = lang ? LANG[lang.slice(0, 2).toLowerCase()] : null;
    const langMismatch = !!(langName && declaredLang.length && !declaredLang.some((x) => x.includes(langName)));
    const notes = [];
    let status = 'ok';
    if (words < 150) { status = 'warn'; notes.push(`only ~${words} words on the homepage`); }
    if (gambling + adult + pharma >= 3) { status = 'warn'; notes.push(`${gambling ? `${gambling} gambling` : ''}${adult ? ` ${adult} adult` : ''}${pharma ? ` ${pharma} pharma` : ''} words on the homepage`.trim()); }
    if (langMismatch) { status = 'warn'; notes.push(`page language “${lang}” but listing says ${declaredLang.join(', ')}`); }
    if (linkSelling >= 3) notes.push(`${linkSelling} “write for us / sponsored” mentions`);
    await put('content', status, { words, gambling, adult, pharma, linkSelling, outLinks, lang, langMismatch },
      notes.length ? notes.join(' · ') : `~${words.toLocaleString('en-US')} words · ${outLinks} external links${lang ? ` · lang ${lang}` : ''}`, 'fetch');
  }

  // 3. DR (free Ahrefs API, 30-day cache)
  let dr = null;
  const c = await keys.cacheGet([domain]).catch(() => ({}));
  if (c[domain]) dr = c[domain].dr;
  else {
    const k = await keys.secretFor('ahrefs', 'AHREFS_API_KEY');
    if (k) {
      try {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10000);
        const r = await fetch(`https://api.ahrefs.com/v3/public/domain-rating-free?target=${encodeURIComponent(domain)}&output=json`, { headers: { Authorization: `Bearer ${k.secret}` }, signal: ac.signal });
        clearTimeout(t);
        const j = await r.json().catch(() => null);
        if (j && j.domain_rating && typeof j.domain_rating.domain_rating === 'number') { dr = j.domain_rating.domain_rating; await keys.cachePut({ [domain]: dr }, 'ahrefs').catch(() => {}); }
      } catch (e) { /* recorded below */ }
    }
  }
  const claimedDr = pw.ahrefs_dr != null ? n(pw.ahrefs_dr) : null;
  if (dr == null) await put('dr', 'warn', { claimed: claimedDr }, 'Could not fetch DR', 'ahrefs');
  else {
    const gap = claimedDr != null ? round(claimedDr - dr, 1) : null;
    const status = dr < 5 ? 'fail' : (gap != null && Math.abs(gap) >= 10) || dr < 15 ? 'warn' : 'ok';
    await put('dr', status, { dr, claimed: claimedDr }, `DR ${dr}${gap != null && Math.abs(gap) >= 10 ? ` (listing says ${claimedDr})` : ''}${dr < 5 ? ' — very low' : ''}`, 'ahrefs');
  }

  // 4. Traffic + top country: Ahrefs Top-Websites first, DataForSEO when Ahrefs does not track it
  const claimedTraffic = pw.ahrefs_traffic != null ? n(pw.ahrefs_traffic) : null;
  const tr = (await fetchTraffic([domain], { paid: opts.paid !== false }).catch(() => ({ byDomain: {} }))).byDomain[domain];
  let measured = null; // traffic we measured ourselves (never the publisher's claim)
  let topCountry = null, share = null;
  const claimTxt = claimedTraffic != null ? ` · listing says ${claimedTraffic.toLocaleString('en-US')}` : '';
  if (tr && tr.source === 'ahrefs' && tr.traffic != null) {
    measured = tr.traffic; topCountry = tr.topCountry; share = tr.share;
    await put('traffic', measured < 100 ? 'warn' : 'ok', { traffic: measured, keywords: tr.keywords, topCountry, share, value: tr.value, month: tr.month, source: 'ahrefs' },
      `Ahrefs organic traffic ${measured.toLocaleString('en-US')}${tr.month ? ` (${tr.month})` : ''}${topCountry ? ` · top country ${topCountry}${share != null ? ` ${share}%` : ''}` : ''}${claimTxt}`, 'ahrefs');
  } else if (tr && tr.source === 'dataforseo') {
    measured = tr.traffic;
    await put('traffic', measured < 100 ? 'warn' : 'ok', { traffic: measured, keywords: tr.keywords, source: 'dataforseo' },
      `DataForSEO estimate ${measured.toLocaleString('en-US')}/month${tr.keywords != null ? ` · ${tr.keywords.toLocaleString('en-US')} keywords` : ''} (Ahrefs does not track this site)${claimTxt}`, 'dataforseo');
  } else {
    await put('traffic', 'warn', { traffic: claimedTraffic, checked: false }, `Traffic could not be measured${claimTxt}`, 'none');
  }
  const traffic = measured != null ? measured : claimedTraffic;
  if (claimedTraffic != null && measured != null && claimedTraffic > 1000 && measured < claimedTraffic * 0.3) {
    out.traffic.status = 'warn';
    out.traffic.detail += ` — listing claims ${round(claimedTraffic / Math.max(1, measured), 1)}× more`;
    await saveCheck(pwId, 'traffic', 'warn', out.traffic.value, out.traffic.detail, out.traffic.source, 0);
  }

  // 5. Spam signal: strong DR, no traffic (measured traffic only)
  if (measured == null) await put('spam', 'ok', { dr, traffic: null }, 'Traffic not measured, so no DR-vs-traffic check', 'derived');
  else if (dr != null && dr >= 40 && measured < 500) await put('spam', 'fail', { dr, traffic: measured }, `DR ${dr} but only ${measured} organic traffic: typical of link farms`, 'derived');
  else if (dr != null && dr >= 25 && measured < 200) await put('spam', 'warn', { dr, traffic: measured }, `DR ${dr} with ${measured} traffic`, 'derived');
  else await put('spam', 'ok', { dr, traffic: measured }, 'DR and traffic look consistent', 'derived');

  // 6. Declared countries vs where traffic really comes from
  const declared = parseList(pw.countries);
  if (topCountry && declared.length) {
    const hit = declared.some((x) => cname(x) === cname(topCountry));
    await put('country', hit ? 'ok' : 'warn', { declared, topCountry, share }, hit ? `Top traffic country ${topCountry} is listed` : `Most traffic from ${topCountry}${share != null ? ` (${share}%)` : ''}, publisher lists ${declared.join(', ')}`, 'derived');
  } else await put('country', 'ok', { declared, topCountry }, topCountry ? `Top traffic country ${topCountry}` : 'No traffic-country data', 'derived');

  // 7. Duplicates
  const dups = rows(await knex().raw(`select p.id, p.submission_status, l.user_id from publisher_websites p left join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id
      where p.id <> ? and regexp_replace(regexp_replace(lower(p.url), '^https{0,1}://', ''), '^www\\.', '') = ?`, [pwId, domain]));
  const otherLive = dups.filter((d) => d.submission_status === 'approved' && d.user_id !== pw.publisher_id);
  const sameOwnerLive = dups.filter((d) => d.submission_status === 'approved' && d.user_id === pw.publisher_id);
  if (otherLive.length) await put('duplicate', 'fail', { ids: otherLive.map((d) => d.id) }, `Already listed by another publisher (#${otherLive.map((d) => d.id).join(', #')})`, 'db');
  else if (sameOwnerLive.length) await put('duplicate', 'warn', { ids: sameOwnerLive.map((d) => d.id) }, 'Same publisher already has this site live', 'db');
  else if (dups.length) await put('duplicate', 'warn', { ids: dups.map((d) => d.id) }, `${dups.length} other submission(s) of this domain (${[...new Set(dups.map((d) => d.submission_status))].join(', ')})`, 'db');
  else await put('duplicate', 'ok', {}, 'No other listing of this domain', 'db');

  // 8. Price sanity
  const gp = n(pw.general_guest_post_price), li = n(pw.general_link_insertion_price);
  const peer = await peerMedian(dr != null ? dr : pw.ahrefs_dr, traffic);
  const allPrices = [gp, li, n(pw.casino_guest_post_price), n(pw.crypto_guest_post_price), n(pw.cbd_guest_post_price), n(pw.dating_guest_post_price)];
  if (!allPrices.some((p) => p > 0)) await put('price', 'fail', { gp, li }, 'No price set (approve will refuse)', 'db');
  else {
    const notes = [];
    let status = 'ok';
    if (!gp) { status = 'warn'; notes.push('no guest post price'); }
    if (peer && gp > peer.median * 3) { status = 'warn'; notes.push(`guest post $${gp} is ${round(gp / peer.median, 1)}× peers ($${peer.median})`); }
    if (peer && gp > 0 && gp < peer.median * 0.2) { status = 'warn'; notes.push(`guest post $${gp} is far below peers ($${peer.median})`); }
    if (peer && li > peer.median * 3) { status = 'warn'; notes.push(`link insertion $${li} is ${round(li / peer.median, 1)}× the peer guest-post price`); }
    if (li > 0 && gp > 0 && li > gp * 1.5) { status = 'warn'; notes.push(`link insertion $${li} costs more than guest post $${gp}`); }
    const niche = [['casino', n(pw.casino_guest_post_price)], ['crypto', n(pw.crypto_guest_post_price)], ['cbd', n(pw.cbd_guest_post_price)], ['dating', n(pw.dating_guest_post_price)]].filter(([, v]) => peer && v > peer.median * 6);
    if (niche.length) { status = 'warn'; notes.push(`${niche.map(([k, v]) => `${k} $${v}`).join(', ')} over 6× peers`); }
    await put('price', status, { gp, li, peerMedian: peer && peer.median, peerCount: peer && peer.count }, (notes.length ? notes.join(' · ') : `Guest post $${gp} · link insertion $${li}`) + (peer ? ` · peers $${peer.median} (${peer.count} sites)` : ''), 'db');
  }

  // 9. Sample posts reachable
  const samples = parseList(pw.sample_posts).filter((s) => /^https?:\/\//i.test(s)).slice(0, 3);
  if (!samples.length) await put('samples', 'warn', { count: 0 }, 'No sample posts given', 'fetch');
  else {
    const res = await Promise.all(samples.map(async (s) => { const p = await fetchPage(s, 10000); return { url: s, status: p.status, sameSite: ascii(canon(p.finalUrl || s)).endsWith(ascii(domain)) }; }));
    const bad = res.filter((x) => !x.status || x.status >= 400 || !x.sameSite);
    await put('samples', bad.length ? 'warn' : 'ok', { samples: res }, bad.length ? `${bad.length} of ${res.length} sample link(s) broken or off-site` : `${res.length} sample link(s) load`, 'fetch');
  }

  // 10. Publisher
  const trust = await publisherTrust(pw.publisher_id);
  if (!trust) await put('publisher', 'warn', null, 'No publisher account linked', 'db');
  else await put('publisher', trust.score < 30 ? 'fail' : trust.score < 50 ? 'warn' : 'ok', trust, `Trust ${trust.score}/100 · ${trust.sites} sites (${trust.approved} live, ${trust.rejected} rejected) · ${trust.completedOrders} orders done`, 'db');

  return summarise(out);
}

const CHECK_ORDER = ['ownership', 'live', 'content', 'dr', 'traffic', 'spam', 'country', 'duplicate', 'price', 'samples', 'publisher'];
function summarise(checks) {
  const list = CHECK_ORDER.filter((k) => checks[k]).map((k) => ({ key: k, ...checks[k] }));
  const fails = list.filter((c) => c.status === 'fail').map((c) => c.key);
  const warns = list.filter((c) => c.status === 'warn').map((c) => c.key);
  // Buckets for the backlog: no human decision is taken automatically.
  const hardReject = fails.some((k) => ['live', 'duplicate', 'spam'].includes(k)) || (checks.dr && checks.dr.value && checks.dr.value.dr != null && checks.dr.value.dr < 5);
  const softWarns = warns.filter((k) => !['traffic', 'samples', 'ownership', 'content'].includes(k));
  const bucket = hardReject ? 'likely_reject' : !fails.length && !softWarns.length ? 'likely_approve' : 'needs_review';
  return { checks: list, fails, warns, bucket };
}

async function getSiteChecks(pwIds) {
  await ensureTables();
  if (!pwIds.length) return new Map();
  const r = rows(await knex().raw('select pw_id, key, status, value, detail, source, ran_at from moderation_checks where pw_id = any(?)', [pwIds]));
  const by = new Map();
  r.forEach((x) => {
    if (!by.has(x.pw_id)) by.set(x.pw_id, {});
    by.get(x.pw_id)[x.key] = { status: x.status, value: typeof x.value === 'string' ? JSON.parse(x.value) : x.value, detail: x.detail, source: x.source, ranAt: x.ran_at };
  });
  const out = new Map();
  for (const [id, checks] of by) out.set(id, { ...summarise(checks), ranAt: Object.values(checks).reduce((m, c) => (!m || c.ranAt > m ? c.ranAt : m), null) });
  return out;
}

// ───────────────────────── locks ─────────────────────────
async function claim(itemKey, admin) {
  await ensureTables();
  const name = admin.username || admin.email || `admin ${admin.id}`;
  const r = rows(await knex().raw(`insert into moderation_locks (item_key, admin_id, admin_name, expires_at) values (?,?,?, now() + interval '${LOCK_MINUTES} minutes')
      on conflict (item_key) do update set admin_id=excluded.admin_id, admin_name=excluded.admin_name, expires_at=excluded.expires_at
        where moderation_locks.admin_id = excluded.admin_id or moderation_locks.expires_at < now()
      returning admin_id`, [itemKey, admin.id, name]))[0];
  if (r) return { ok: true, holder: { id: admin.id, name } };
  const h = rows(await knex().raw('select admin_id, admin_name, expires_at from moderation_locks where item_key=?', [itemKey]))[0];
  return { ok: false, holder: h ? { id: h.admin_id, name: h.admin_name, until: h.expires_at } : null };
}
async function release(itemKey, adminId) { await ensureTables(); await knex().raw('delete from moderation_locks where item_key=? and admin_id=?', [itemKey, adminId]); }
async function locks() {
  await ensureTables();
  const r = rows(await knex().raw('select item_key, admin_id, admin_name, expires_at from moderation_locks where expires_at > now()'));
  return Object.fromEntries(r.map((x) => [x.item_key, { id: x.admin_id, name: x.admin_name, until: x.expires_at }]));
}
async function assertNotLockedByOther(itemKey, adminId) {
  const h = rows(await knex().raw('select admin_id, admin_name from moderation_locks where item_key=? and expires_at > now()', [itemKey]))[0];
  if (h && h.admin_id !== adminId) throw Object.assign(new Error(`${h.admin_name} is reviewing this item right now`), { status: 409 });
}

// ───────────────────────── decisions ─────────────────────────
async function logDecision(d) {
  await ensureTables();
  await knex().raw(`insert into moderation_decisions (item_type, item_id, pw_id, marketplace_id, action, reason_code, note, publisher_message, checklist, snapshot, admin_id, admin_name, auto, submitted_at)
      values (?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,?,?)`,
  [d.itemType, d.itemId, d.pwId || null, d.marketplaceId || null, d.action, d.reasonCode || null, d.note || null, d.publisherMessage || null,
    JSON.stringify(d.checklist || null), JSON.stringify(d.snapshot || null), d.adminId || null, d.adminName || null, !!d.auto, d.submittedAt || null]);
}

async function notifyPublisher(userId, title, message, url) {
  if (!userId) return;
  try { await strapi.service('api::notification.notification').createNotification({ recipientId: userId, type: 'system', action: 'system_update', title, message, data: url ? { url } : null }); }
  catch (e) { strapi.log.warn(`[MODERATION] notification failed: ${e.message}`); }
}

/** Call an existing controller action with a minimal ctx (same approach as website-update-request.bulkProcess). */
async function callController(uid, action, { id, body, user }) {
  let failure = null;
  let sent = null;
  const shim = {
    params: { id: String(id) }, state: { user }, request: { body: body || {} }, query: {},
    send(b) { sent = b; return b; },
    badRequest(m) { failure = { status: 400, message: m }; return failure; },
    notFound(m) { failure = { status: 404, message: m }; return failure; },
    forbidden(m) { failure = { status: 403, message: m }; return failure; },
    unauthorized(m) { failure = { status: 401, message: m }; return failure; },
    internalServerError(m) { failure = { status: 500, message: m }; return failure; },
  };
  const out = await strapi.controller(uid)[action](shim);
  if (failure) throw Object.assign(new Error(failure.message || 'Failed'), { status: failure.status });
  return sent || out;
}

// ───────────────────────── re-check flags ─────────────────────────
/** Open a flag for live listings whose DR fell ≥20 or traffic ≥80% (from ≥1,000) in the last `days`. */
async function scanFlags(days = 2) {
  await ensureTables();
  const dr = await knex().raw(`insert into moderation_flags (marketplace_id, kind, from_value, to_value, detail)
      select distinct on (h.marketplace_id) h.marketplace_id, 'dr_drop', (h.changes->'ahrefs_dr'->>'from')::numeric, (h.changes->'ahrefs_dr'->>'to')::numeric, 'DR fell by 20+ points'
      from (select l.marketplace_id, x.changes, x.created_at from marketplace_update_histories x join marketplace_update_histories_marketplace_lnk l on l.marketplace_update_history_id=x.id
            where x.created_at > now() - (? || ' days')::interval and (x.changes -> 'ahrefs_dr') is not null) h
      join marketplaces m on m.id=h.marketplace_id and m.status='active'
      where (h.changes->'ahrefs_dr'->>'from') ~ '^[0-9.]+$' and (h.changes->'ahrefs_dr'->>'to') ~ '^[0-9.]+$'
        and (h.changes->'ahrefs_dr'->>'from')::numeric - (h.changes->'ahrefs_dr'->>'to')::numeric >= 20
      order by h.marketplace_id, h.created_at desc
      on conflict (marketplace_id, kind, status) do nothing`, [String(days)]);
  const tr = await knex().raw(`insert into moderation_flags (marketplace_id, kind, from_value, to_value, detail)
      select distinct on (h.marketplace_id) h.marketplace_id, 'traffic_drop', (h.changes->'ahrefs_traffic'->>'from')::numeric, (h.changes->'ahrefs_traffic'->>'to')::numeric, 'Organic traffic fell 80%+'
      from (select l.marketplace_id, x.changes, x.created_at from marketplace_update_histories x join marketplace_update_histories_marketplace_lnk l on l.marketplace_update_history_id=x.id
            where x.created_at > now() - (? || ' days')::interval and (x.changes -> 'ahrefs_traffic') is not null) h
      join marketplaces m on m.id=h.marketplace_id and m.status='active'
      where (h.changes->'ahrefs_traffic'->>'from') ~ '^[0-9.]+$' and (h.changes->'ahrefs_traffic'->>'to') ~ '^[0-9.]+$'
        and (h.changes->'ahrefs_traffic'->>'from')::numeric >= 1000
        and (h.changes->'ahrefs_traffic'->>'to')::numeric < (h.changes->'ahrefs_traffic'->>'from')::numeric * 0.2
      order by h.marketplace_id, h.created_at desc
      on conflict (marketplace_id, kind, status) do nothing`, [String(days)]);
  return { dr: dr.rowCount || 0, traffic: tr.rowCount || 0 };
}

// ───────────────────────── settings ─────────────────────────
const DEFAULT_SETTINGS = {
  autoApproveEnabled: false, // Phase 4: only turns on when an admin enables it
  autoApproveNoiseOnly: false, // when on, requests with no real change are closed as "no change"
  autoApproveMaxRisk: 'low',
  autoApproveMinTrust: 70,
  slaHoursEdits: 24,
  slaHoursSites: 48,
};
async function getSettings() {
  await ensureTables();
  const r = rows(await knex().raw("select value from moderation_settings where key='rules'"))[0];
  return { ...DEFAULT_SETTINGS, ...(r ? (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) : {}) };
}
async function saveSettings(patch, adminId) {
  const cur = await getSettings();
  const next = { ...cur };
  if (typeof patch.autoApproveEnabled === 'boolean') next.autoApproveEnabled = patch.autoApproveEnabled;
  if (typeof patch.autoApproveNoiseOnly === 'boolean') next.autoApproveNoiseOnly = patch.autoApproveNoiseOnly;
  if (['low', 'medium'].includes(patch.autoApproveMaxRisk)) next.autoApproveMaxRisk = patch.autoApproveMaxRisk;
  if (Number.isFinite(Number(patch.autoApproveMinTrust))) next.autoApproveMinTrust = Math.max(0, Math.min(100, Number(patch.autoApproveMinTrust)));
  ['slaHoursEdits', 'slaHoursSites'].forEach((k) => { if (Number.isFinite(Number(patch[k]))) next[k] = Math.max(1, Math.min(720, Number(patch[k]))); });
  await knex().raw(`insert into moderation_settings (key, value, updated_at, updated_by) values ('rules', ?::jsonb, now(), ?)
      on conflict (key) do update set value=excluded.value, updated_at=now(), updated_by=excluded.updated_by`, [JSON.stringify(next), adminId || null]);
  return next;
}

module.exports = {
  ensureTables, LABELS, norm, fieldRisk, listEdits, peerMedian, publisherTrust,
  runSiteChecks, getSiteChecks, summarise, canon, fetchTraffic, spendToday,
  claim, release, locks, assertNotLockedByOther, logDecision, notifyPublisher, callController,
  scanFlags, getSettings, saveSettings, LEVEL,
};
