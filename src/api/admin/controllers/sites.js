'use strict';

/**
 * Sites: one admin view over publisher_websites (the submission) and
 * marketplaces (the live listing). 2026-10-13.
 *
 *   GET  /admin/sites            list: views, filters, search, sort, pagination
 *   GET  /admin/sites/counts     number of sites in each view (cached 60 s)
 *   GET  /admin/sites/export     CSV of the current filters (max 30,000 rows)
 *   GET  /admin/sites/lookup     ?url=  duplicate check + suggested price for "Add site"
 *   POST /admin/sites/bulk       { action, ids[] | items[] }  bulk edits; returns the old
 *                                values so the UI can undo
 *
 * Writes go through the existing controllers (websites.update keeps the
 * listing in sync; marketplace.toggleStatus / marketplace.update for
 * listing-only fields), so emails, history rows and sync logic are unchanged.
 * Never selects secret columns (gsc_refresh_token).
 */
const microCache = require('../services/micro-cache');

const r2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const num = (v) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n; };

function can(user, key, kind = 'view') {
  if (user && user.role && user.role.type === 'super_admin') return true;
  const e = ((user && user.pagePermissions) || {})[key];
  if (!e) return false;
  return kind === 'view' ? !!(e.view || e.edit || e.create || e.delete) : !!e[kind];
}

// unified status for one site
const STATUS_SQL = `case
    when p.submission_status = 'approved' and m.status = 'active' then 'live'
    when p.submission_status = 'approved' and m.status = 'paused' then 'paused'
    when p.submission_status = 'approved' and m.status = 'delisted' then 'delisted'
    when p.submission_status = 'listing_paused' then 'paused'
    when p.submission_status = 'approval_pending' and p.marketplace_id is not null then 'resubmitted'
    when p.submission_status = 'approval_pending' then 'waiting'
    when p.submission_status = 'pending_verification' then 'verifying'
    when p.submission_status = 'pending_final_submission' then 'incomplete'
    when p.submission_status = 'rejected' then 'rejected'
    when p.submission_status in ('ownership_transferred', 'ownership_claimed') then 'transferred'
    else p.submission_status end`;

const BASE = `
  with ord as (
    select l.marketplace_id, count(*)::int n, count(*) filter (where o.order_status = 'completed')::int done, max(o.created_at) last_order
      from orders o join orders_website_lnk l on l.order_id = o.id group by 1),
  flg as (select marketplace_id, array_agg(distinct kind) kinds from moderation_flags where status = 'open' group by 1),
  chk as (select pw_id, count(*) filter (where status = 'fail')::int fails, count(*) filter (where status = 'warn')::int warns, max(ran_at) ran_at from moderation_checks group by 1),
  edt as (select distinct l.publisher_website_id pw_id from website_update_requests w join website_update_requests_publisher_website_lnk l on l.website_update_request_id = w.id where w.status = 'pending'),
  s as (
    select p.id, p.url, p.submission_status, ${STATUS_SQL} as status, p.created_at, p.approved_at, p.reviewed_at, p.updated_at,
           p.marketplace_id, p.reseller_code, p.gsc_verified, p.verification_method,
           p.general_guest_post_price as pw_price, p.general_link_insertion_price as pw_li_price,
           coalesce(m.price, p.general_guest_post_price) as price, coalesce(m.link_insertion_price, p.general_link_insertion_price) as li_price,
           coalesce(m.ahrefs_dr, p.ahrefs_dr) as dr, coalesce(m.moz_da, p.moz_da) as da, coalesce(m.ahrefs_traffic, p.ahrefs_traffic) as traffic,
           m.traffic_source, coalesce(m.ahrefs_top_country, p.ahrefs_top_country) as top_country, m.spam_score,
           coalesce(m.category, p.category) as category, coalesce(m.language, p.language) as language, coalesce(m.countries, p.countries) as countries,
           coalesce(m.tat, round(p.expected_tat_hours / 24.0)) as tat_days,
           coalesce(m.is_featured_guest_post, false) or coalesce(m.is_featured_link_insertion, false) as featured,
           coalesce(m.assured_placement, false) as assured, m.status as listing_status,
           m.last_price_update_at, m.last_ahrefs_refresh_at, coalesce(m.rank_score, 0) rank_score,
           u.id as publisher_id, coalesce(nullif(trim(concat(u.first_name, ' ', u.last_name)), ''), u.username, p.publisher_name) as publisher_name,
           coalesce(u.email, p.publisher_email) as publisher_email,
           coalesce(ord.n, 0) orders, coalesce(ord.done, 0) completed, ord.last_order,
           coalesce(flg.kinds, '{}') flags, chk.fails, chk.warns, chk.ran_at checks_at, (edt.pw_id is not null) edit_pending
      from publisher_websites p
      left join marketplaces m on m.id = p.marketplace_id
      left join publisher_websites_current_publisher_id_lnk cl on cl.publisher_website_id = p.id
      left join up_users u on u.id = cl.user_id
      left join ord on ord.marketplace_id = p.marketplace_id
      left join flg on flg.marketplace_id = p.marketplace_id
      left join chk on chk.pw_id = p.id
      left join edt on edt.pw_id = p.id)`;

const VIEWS = {
  all: 'true',
  live: "status = 'live'",
  ready: "status = 'waiting' and checks_at is not null and coalesce(fails, 0) = 0",
  needs_look: "status = 'waiting' and coalesce(fails, 0) > 0",
  unchecked: "status = 'waiting' and checks_at is null",
  waiting: "status = 'waiting'",
  resubmitted: "status = 'resubmitted'",
  verifying: "status = 'verifying'",
  incomplete: "status = 'incomplete'",
  edits: 'edit_pending',
  flagged: "cardinality(flags) > 0 and status = 'live'",
  assured: 'assured',
  featured: "featured and status = 'live'",
  never_ordered: "status = 'live' and orders = 0",
  stale_price: "status = 'live' and (last_price_update_at is null or last_price_update_at < now() - interval '180 days')",
  stale_metrics: "status = 'live' and (last_ahrefs_refresh_at is null or last_ahrefs_refresh_at < now() - interval '60 days')",
  new_week: "created_at > now() - interval '7 days'",
  paused: "status in ('paused', 'delisted')",
  rejected: "status = 'rejected'",
};
const SORTS = {
  created: 'created_at', updated: 'updated_at', url: 'url', price: 'price', li_price: 'li_price', dr: 'dr', da: 'da', traffic: 'traffic',
  orders: 'orders', last_order: 'last_order', price_age: 'last_price_update_at', metrics_age: 'last_ahrefs_refresh_at', waiting: 'created_at',
  rank: 'rank_score', publisher: 'publisher_name', status: 'status',
};

function where(qs) {
  const c = []; const b = [];
  c.push(VIEWS[qs.view] || 'true');
  const q = String(qs.q || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  if (q) {
    if (/^#?\d+$/.test(q)) { c.push('(id = ? or marketplace_id = ?)'); const n = int(q.replace('#', '')); b.push(n, n); }
    else { c.push('(url ilike ? or publisher_email ilike ? or publisher_name ilike ?)'); const l = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`; b.push(l, l, l); }
  }
  if (qs.status) { const list = String(qs.status).split(',').filter(Boolean).slice(0, 10); c.push(`status = any(?)`); b.push(list); }
  const range = (col, lo, hi) => { if (num(lo) != null) { c.push(`${col} >= ?`); b.push(num(lo)); } if (num(hi) != null) { c.push(`${col} <= ?`); b.push(num(hi)); } };
  range('dr', qs.drMin, qs.drMax); range('da', qs.daMin, qs.daMax); range('price', qs.priceMin, qs.priceMax); range('traffic', qs.trafficMin, qs.trafficMax);
  if (qs.country) { c.push(`(top_country = ? or countries::text ilike ?)`); b.push(String(qs.country).toUpperCase().slice(0, 2), `%${String(qs.country).slice(0, 40)}%`); }
  if (qs.language) { c.push('language::text ilike ?'); b.push(`%${String(qs.language).slice(0, 40)}%`); }
  if (qs.category) { c.push('category::text ilike ?'); b.push(`%${String(qs.category).slice(0, 60)}%`); }
  if (qs.flag) { c.push('? = any(flags)'); b.push(String(qs.flag).slice(0, 30)); }
  if (qs.assured === '1') c.push('assured');
  if (qs.featured === '1') c.push('featured');
  if (qs.hasOrders === '1') c.push('orders > 0'); else if (qs.hasOrders === '0') c.push('orders = 0');
  if (qs.reseller === '1') c.push("coalesce(reseller_code, '') <> ''");
  if (int(qs.publisherId)) { c.push('publisher_id = ?'); b.push(int(qs.publisherId)); }
  if (int(qs.addedDays)) { c.push(`created_at > now() - (? || ' days')::interval`); b.push(String(int(qs.addedDays))); }
  return { sql: c.join(' and '), b };
}

const shape = (r) => ({
  id: r.id, url: r.url, status: r.status, submissionStatus: r.submission_status, listingId: r.marketplace_id, listingStatus: r.listing_status,
  price: r2(r.price), liPrice: r2(r.li_price), dr: r.dr != null ? Number(r.dr) : null, da: r.da != null ? Number(r.da) : null,
  traffic: r.traffic != null ? Number(r.traffic) : null, trafficSource: r.traffic_source || null, topCountry: r.top_country || null,
  spam: r.spam_score != null ? Number(r.spam_score) : null,
  category: Array.isArray(r.category) ? r.category : [], language: Array.isArray(r.language) ? r.language : [], countries: Array.isArray(r.countries) ? r.countries : [],
  tatDays: r.tat_days != null ? Number(r.tat_days) : null, featured: !!r.featured, assured: !!r.assured,
  publisher: { id: r.publisher_id || null, name: r.publisher_name || null, email: r.publisher_email || null },
  orders: r.orders, completed: r.completed, lastOrder: r.last_order, flags: r.flags || [],
  checks: r.checks_at ? { fails: r.fails || 0, warns: r.warns || 0, ranAt: r.checks_at } : null, editPending: !!r.edit_pending,
  resellerCode: r.reseller_code || null, verified: !!r.gsc_verified || !!r.verification_method,
  createdAt: r.created_at, approvedAt: r.approved_at, updatedAt: r.updated_at, priceUpdatedAt: r.last_price_update_at, metricsUpdatedAt: r.last_ahrefs_refresh_at,
});

const csvCell = (v) => {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('; ') : v instanceof Date ? v.toISOString() : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

module.exports = {
  async list(ctx) {
    const user = ctx.state.user;
    if (!can(user, 'websites') && !can(user, 'marketplace')) return ctx.forbidden('No access to sites');
    const qs = ctx.query || {};
    const page = Math.max(1, int(qs.page) || 1);
    const pageSize = Math.min(200, Math.max(10, int(qs.pageSize) || 50));
    const sortCol = SORTS[qs.sort] || (qs.view === 'ready' || qs.view === 'waiting' || qs.view === 'needs_look' ? 'created_at' : 'created_at');
    const dir = qs.dir === 'asc' || ((qs.view === 'ready' || qs.view === 'waiting' || qs.view === 'needs_look') && !qs.dir && !qs.sort) ? 'asc' : 'desc';
    const w = where(qs);
    const sql = `${BASE} select *, count(*) over() total from s where ${w.sql} order by ${sortCol} ${dir} nulls last, id desc limit ? offset ?`;
    const rows = (await strapi.db.connection.raw(sql, [...w.b, pageSize, (page - 1) * pageSize])).rows;
    const total = rows.length ? Number(rows[0].total) : 0;
    ctx.send({ data: rows.map(shape), pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) } });
  },

  async counts(ctx) {
    const user = ctx.state.user;
    if (!can(user, 'websites') && !can(user, 'marketplace')) return ctx.forbidden('No access to sites');
    const fresh = ctx.query.fresh === '1';
    const compute = async () => {
      const parts = Object.entries(VIEWS).map(([k, cond]) => `count(*) filter (where ${cond})::int as "${k}"`).join(', ');
      return (await strapi.db.connection.raw(`${BASE} select ${parts} from s`)).rows[0];
    };
    if (fresh) { const v = await compute(); microCache.set('sites-counts', v); return ctx.send(v); }
    ctx.send(await microCache.memo('sites-counts', 60 * 1000, compute));
  },

  async exportCsv(ctx) {
    const user = ctx.state.user;
    if (!can(user, 'websites') && !can(user, 'marketplace')) return ctx.forbidden('No access to sites');
    const w = where(ctx.query || {});
    const rows = (await strapi.db.connection.raw(`${BASE} select * from s where ${w.sql} order by id desc limit 30000`, w.b)).rows.map(shape);
    const cols = [['id', 'id'], ['url', 'url'], ['status', 'status'], ['listing_id', 'listingId'], ['price', 'price'], ['li_price', 'liPrice'], ['dr', 'dr'], ['da', 'da'],
      ['traffic', 'traffic'], ['traffic_source', 'trafficSource'], ['top_country', 'topCountry'], ['category', 'category'], ['language', 'language'], ['countries', 'countries'],
      ['tat_days', 'tatDays'], ['featured', 'featured'], ['assured', 'assured'], ['orders', 'orders'], ['completed', 'completed'], ['flags', 'flags'],
      ['publisher_name', (r) => r.publisher.name], ['publisher_email', (r) => r.publisher.email], ['created_at', 'createdAt'], ['price_updated_at', 'priceUpdatedAt'], ['metrics_updated_at', 'metricsUpdatedAt']];
    const csv = [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map(([, k]) => csvCell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\n');
    strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
      data: { adminUser: user.id, action: 'export_csv', details: { kind: 'sites', rows: rows.length, filters: ctx.query }, ipAddress: ctx.request.ip || null, createdAt: new Date(), updatedAt: new Date() },
    }).catch(() => {});
    ctx.set('Content-Type', 'text/csv; charset=utf-8');
    ctx.set('Content-Disposition', `attachment; filename="serpbays-sites-${new Date().toISOString().slice(0, 10)}.csv"`);
    ctx.body = '﻿' + csv;
  },

  /** Before adding a site: is it already on Serpbays, and what do similar sites cost? */
  async lookup(ctx) {
    const user = ctx.state.user;
    if (!can(user, 'websites') && !can(user, 'marketplace')) return ctx.forbidden('No access to sites');
    const raw = String(ctx.query.url || '').trim().toLowerCase();
    const domain = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return ctx.badRequest('Enter a domain like example.com');
    const knex = strapi.db.connection;
    const canon = `regexp_replace(regexp_replace(regexp_replace(lower(url), '^(http|https)://', ''), '^www\\.', ''), '/.*$', '')`;
    const [existing, listings] = await Promise.all([
      knex.raw(`select p.id, p.url, p.submission_status, p.marketplace_id, p.publisher_email from publisher_websites p where ${canon} = ? order by p.id desc limit 5`, [domain]),
      knex.raw(`select id, url, status, price, ahrefs_dr from marketplaces where ${canon} = ? limit 5`, [domain]),
    ]);
    let metrics = null;
    try {
      const k = await require('../services/integration-keys').secretFor('ahrefs', 'AHREFS_API_KEY');
      if (k && k.secret) {
        const r = await fetch(`https://api.ahrefs.com/v3/public/domain-rating-free?target=${encodeURIComponent(domain)}&output=json`, { headers: { Authorization: `Bearer ${k.secret}` }, signal: AbortSignal.timeout(8000) });
        if (r.ok) { const j = await r.json(); const v = j && j.domain_rating && j.domain_rating.domain_rating; if (v != null) metrics = { dr: Number(v), source: 'ahrefs' }; }
      }
    } catch (_) { /* metrics are a nice-to-have */ }
    const dr = metrics ? metrics.dr : null;
    let suggestion = null;
    if (dr != null) {
      const lo = Math.max(0, Math.floor(dr / 10) * 10); const hi = lo + 9;
      const r = (await knex.raw(`select count(*)::int n, percentile_cont(0.25) within group (order by price) p25, percentile_cont(0.5) within group (order by price) p50, percentile_cont(0.75) within group (order by price) p75
          from marketplaces where status = 'active' and price > 5 and ahrefs_dr between ? and ?`, [lo, hi])).rows[0];
      if (r && r.n > 0) suggestion = { drBand: `${lo}-${hi}`, sites: r.n, low: Math.round(r.p25), median: Math.round(r.p50), high: Math.round(r.p75) };
    }
    ctx.send({ domain, existing: existing.rows, listings: listings.rows.map((x) => ({ ...x, price: r2(x.price) })), metrics, suggestion });
  },

  /**
   * Bulk edits. Body:
   *   { action: 'update', items: [{ id, changes: { price?, liPrice?, tatDays?, category? } }] }   → websites.update
   *   { action: 'price_pct', ids, pct }                         → price × (1 + pct/100), rounded
   *   { action: 'pause' | 'activate', ids }                     → listing status
   *   { action: 'feature' | 'unfeature', ids }                  → listing featured (GP + LI)
   *   { action: 'set_listing', items: [{ id, status?, featured? }] } → used by Undo
   * Returns { results: [{ id, ok, error?, before? }] }. `before` lets the UI undo.
   */
  async bulk(ctx) {
    const user = ctx.state.user;
    const b = ctx.request.body || {};
    const action = String(b.action || '');
    const needs = ['update', 'price_pct'].includes(action) ? 'websites' : 'marketplace';
    if (!can(user, needs, 'edit')) return ctx.forbidden(`Needs ${needs} edit permission`);
    const knex = strapi.db.connection;
    const callController = require('../services/moderation').callController;
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(int).filter(Boolean).slice(0, 500);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 500);
    const rowsFor = async (list) => (await knex.raw(`select p.id, p.url, p.marketplace_id, p.submission_status, p.general_guest_post_price gp, p.general_link_insertion_price li, p.expected_tat_hours tat_h, p.category,
        m.status mstatus, m.is_featured_guest_post fgp, m.is_featured_link_insertion fli from publisher_websites p left join marketplaces m on m.id = p.marketplace_id where p.id = any(?)`, [list])).rows;
    const results = [];
    const run = async (id, fn) => { try { const before = await fn(); results.push({ id, ok: true, before }); } catch (e) { results.push({ id, ok: false, error: e.message || 'Failed' }); } };
    const updateSite = async (row, changes) => {
      const body = {};
      if (changes.price != null) body.generalGuestPostPrice = Math.max(0, Math.round(Number(changes.price)));
      if (changes.liPrice != null) body.generalLinkInsertionPrice = Math.max(0, Math.round(Number(changes.liPrice)));
      if (changes.tatDays != null) body.expectedTATHours = Math.max(1, Math.round(Number(changes.tatDays))) * 24;
      if (Array.isArray(changes.category)) body.category = changes.category.map(String).slice(0, 10);
      if (!Object.keys(body).length) throw new Error('Nothing to change');
      await callController('api::admin.websites', 'update', { id: row.id, user, body });
      let cat = row.category; if (typeof cat === 'string') { try { cat = JSON.parse(cat); } catch { cat = []; } }
      return { price: r2(row.gp), liPrice: r2(row.li), tatDays: row.tat_h != null ? Math.round(row.tat_h / 24) : null, category: Array.isArray(cat) ? cat : [] };
    };
    const setListing = async (row, patch) => {
      if (!row.marketplace_id) throw new Error('Not live yet (no listing)');
      const before = { status: row.mstatus, featured: !!(row.fgp || row.fli) };
      if (patch.status && patch.status !== row.mstatus) {
        if (!['active', 'paused'].includes(patch.status)) throw new Error('Only pause/activate here');
        await callController('api::admin.marketplace', 'toggleStatus', { id: row.marketplace_id, user, body: { active: patch.status === 'active', reason: 'Sites bulk action' } });
      }
      if (patch.featured != null) {
        await callController('api::admin.marketplace', 'update', { id: row.marketplace_id, user, body: { isFeaturedGuestPost: !!patch.featured, isFeaturedLinkInsertion: !!patch.featured } });
      }
      return before;
    };
    if (action === 'update' || action === 'set_listing') {
      const map = new Map((await rowsFor(items.map((i) => int(i.id)).filter(Boolean))).map((r) => [r.id, r]));
      for (const it of items) {
        const row = map.get(int(it.id));
        await run(int(it.id), async () => { if (!row) throw new Error('Not found'); return action === 'update' ? updateSite(row, it.changes || {}) : setListing(row, it); });
      }
    } else if (action === 'price_pct') {
      const pct = num(b.pct);
      if (pct == null || pct < -90 || pct > 500) return ctx.badRequest('pct must be between -90 and 500');
      for (const row of await rowsFor(ids)) {
        await run(row.id, () => {
          if (!row.gp) throw new Error('No guest post price');
          const changes = { price: Math.round(Number(row.gp) * (1 + pct / 100)) };
          if (row.li) changes.liPrice = Math.round(Number(row.li) * (1 + pct / 100));
          return updateSite(row, changes);
        });
      }
    } else if (['pause', 'activate', 'feature', 'unfeature'].includes(action)) {
      for (const row of await rowsFor(ids)) {
        await run(row.id, () => setListing(row, action === 'pause' ? { status: 'paused' } : action === 'activate' ? { status: 'active' } : { featured: action === 'feature' }));
      }
    } else {
      return ctx.badRequest('Unknown action');
    }
    microCache.del('sites-counts');
    ctx.send({ action, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
  },
};
