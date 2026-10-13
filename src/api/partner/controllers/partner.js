'use strict';

/**
 * Serpbays customer API v1 (read-only catalog), 2026-10-13.
 *
 *   GET /api/v1/sites          list live marketplace sites with buyer prices
 *   GET /api/v1/sites/:id      one site
 *   GET /api/v1/categories     categories with site counts
 *   GET /api/v1/me             this key's limits and today's usage
 *
 * Only what buyers already see on the marketplace: no publisher identity,
 * publisher prices or internal fields. A price of 0 means "not offered" and is
 * returned as null.
 */
const r2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
const offered = (n) => (n != null && Number(n) > 0 ? r2(n) : null);
const num = (v) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n; };
const arr = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string' && v.trim().startsWith('[')) { try { return JSON.parse(v); } catch { return []; } } return v ? [v] : []; };

const COLS = `m.id, m.url, m.ahrefs_dr, m.moz_da, m.ahrefs_traffic, m.traffic_source, m.ahrefs_top_country, m.ahrefs_top_country_share, m.spam_score,
  m.category, m.language, m.countries, m.price, m.link_insertion_price,
  m.adv_casino_pricing, m.adv_li_casino_pricing, m.adv_crypto_pricing, m.adv_li_crypto_pricing, m.adv_cbd_pricing, m.adv_li_cbd_pricing,
  m.adv_dating_pricing, m.adv_li_dating_pricing, m.tat, m.backlink_type, m.dofollow_link, m.backlink_validity, m.sponsored, m.ugc,
  m.min_word_count, m.digital_pr, m.assured_placement, m.guidelines, m.sample_links, m.last_price_update_at, m.updated_at, m.created_at`;
const BASE_WHERE = `m.status = 'active' and (coalesce(m.price, 0) > 0 or coalesce(m.link_insertion_price, 0) > 0)`;
const SORTS = { dr: 'm.ahrefs_dr', da: 'm.moz_da', traffic: 'm.ahrefs_traffic', price: 'nullif(m.price, 0)', updated: 'm.updated_at', created: 'm.created_at', id: 'm.id' };

function shape(r) {
  const yes = (v) => v === true || v === 'true' || v === '1' || v === 1;
  return {
    id: r.id,
    domain: r.url,
    metrics: {
      dr: r.ahrefs_dr != null ? Number(r.ahrefs_dr) : null,
      da: r.moz_da != null ? Number(r.moz_da) : null,
      traffic: r.ahrefs_traffic != null ? Number(r.ahrefs_traffic) : null,
      traffic_source: r.traffic_source || (r.ahrefs_traffic != null ? 'ahrefs' : null),
      top_country: r.ahrefs_top_country || null,
      top_country_share: r.ahrefs_top_country_share != null ? Number(r.ahrefs_top_country_share) : null,
      spam_score: r.spam_score != null ? Number(r.spam_score) : null,
    },
    categories: arr(r.category), languages: arr(r.language), countries: arr(r.countries),
    prices: {
      currency: 'USD',
      guest_post: offered(r.price), link_insertion: offered(r.link_insertion_price),
      casino: { guest_post: offered(r.adv_casino_pricing), link_insertion: offered(r.adv_li_casino_pricing) },
      crypto: { guest_post: offered(r.adv_crypto_pricing), link_insertion: offered(r.adv_li_crypto_pricing) },
      cbd: { guest_post: offered(r.adv_cbd_pricing), link_insertion: offered(r.adv_li_cbd_pricing) },
      dating: { guest_post: offered(r.adv_dating_pricing), link_insertion: offered(r.adv_li_dating_pricing) },
    },
    link: { type: r.backlink_type || null, dofollow: r.dofollow_link || null, validity: r.backlink_validity || null, sponsored: yes(r.sponsored), ugc: yes(r.ugc) },
    turnaround_days: r.tat != null ? Number(r.tat) : null,
    min_words: r.min_word_count != null ? Number(r.min_word_count) : null,
    digital_pr: yes(r.digital_pr),
    assured_placement: r.assured_placement === true,
    guidelines: r.guidelines || null,
    sample_links: arr(r.sample_links).filter((x) => typeof x === 'string').slice(0, 5),
    url: `https://app.serpbays.com/marketplace/${r.id}`,
    price_updated_at: r.last_price_update_at, updated_at: r.updated_at, listed_at: r.created_at,
  };
}

function filters(q) {
  const c = [BASE_WHERE]; const b = [];
  const range = (col, lo, hi) => { if (num(lo) != null) { c.push(`${col} >= ?`); b.push(num(lo)); } if (num(hi) != null) { c.push(`${col} <= ?`); b.push(num(hi)); } };
  range('m.ahrefs_dr', q.dr_min, q.dr_max); range('m.moz_da', q.da_min, q.da_max); range('m.ahrefs_traffic', q.traffic_min, q.traffic_max); range('m.price', q.price_min, q.price_max);
  if (q.domain) { c.push('m.url ilike ?'); b.push(`%${String(q.domain).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[%_\\]/g, (x) => '\\' + x).slice(0, 100)}%`); }
  if (q.category) { c.push('m.category::text ilike ?'); b.push(`%${String(q.category).slice(0, 60)}%`); }
  if (q.language) { c.push('m.language::text ilike ?'); b.push(`%${String(q.language).slice(0, 40)}%`); }
  if (q.country) { c.push('(m.ahrefs_top_country = ? or m.countries::text ilike ?)'); b.push(String(q.country).toUpperCase().slice(0, 2), `%${String(q.country).slice(0, 40)}%`); }
  if (q.assured === 'true' || q.assured === '1') c.push('m.assured_placement = true');
  if (q.link_insertion === 'true' || q.link_insertion === '1') c.push('coalesce(m.link_insertion_price, 0) > 0');
  const niche = String(q.niche || '').toLowerCase();
  const NICHE = { casino: 'adv_casino_pricing', crypto: 'adv_crypto_pricing', cbd: 'adv_cbd_pricing', dating: 'adv_dating_pricing' };
  if (NICHE[niche]) c.push(`coalesce(m.${NICHE[niche]}, 0) > 0`);
  if (q.updated_since) { const d = new Date(String(q.updated_since)); if (!Number.isNaN(d.getTime())) { c.push('m.updated_at >= ?'); b.push(d.toISOString()); } }
  if (q.listed_since) { const d = new Date(String(q.listed_since)); if (!Number.isNaN(d.getTime())) { c.push('m.created_at >= ?'); b.push(d.toISOString()); } }
  return { sql: c.join(' and '), b };
}
const bad = (ctx, message) => { ctx.status = 400; ctx.body = { error: { code: 'bad_request', message } }; };

module.exports = {
  async sites(ctx) {
    const q = ctx.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(q.per_page, 10) || 50));
    if (page * perPage > 100000) return bad(ctx, 'Use updated_since / filters instead of paging past 100,000 rows.');
    const sort = SORTS[String(q.sort || 'dr')];
    if (!sort) return bad(ctx, `sort must be one of ${Object.keys(SORTS).join(', ')}`);
    const dir = String(q.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const f = filters(q);
    const knex = strapi.db.connection;
    const [rows, count] = await Promise.all([
      knex.raw(`select ${COLS} from marketplaces m where ${f.sql} order by ${sort} ${dir} nulls last, m.id asc limit ? offset ?`, [...f.b, perPage, (page - 1) * perPage]),
      knex.raw(`select count(*)::int n from marketplaces m where ${f.sql}`, f.b),
    ]);
    const total = count.rows[0].n;
    ctx.body = { data: rows.rows.map(shape), meta: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) } };
  },

  async site(ctx) {
    const id = parseInt(ctx.params.id, 10);
    if (!id) return bad(ctx, 'id must be a number');
    const r = (await strapi.db.connection.raw(`select ${COLS} from marketplaces m where m.id = ? and ${BASE_WHERE}`, [id])).rows[0];
    if (!r) { ctx.status = 404; ctx.body = { error: { code: 'not_found', message: 'No live site with this id.' } }; return; }
    ctx.body = { data: shape(r) };
  },

  async categories(ctx) {
    const rows = (await strapi.db.connection.raw(`select c as name, count(*)::int sites from marketplaces m, jsonb_array_elements_text(case when jsonb_typeof(m.category) = 'array' then m.category else '[]'::jsonb end) c
        where ${BASE_WHERE} group by 1 order by 2 desc`)).rows;
    ctx.body = { data: rows };
  },

  async me(ctx) {
    const k = ctx.state.apiKey;
    const u = (await strapi.db.connection.raw('select requests, errors, rows_returned from api_usage_daily where key_id = ? and day = current_date', [k.id])).rows[0] || {};
    ctx.body = { data: { key: `${k.key_prefix}…`, label: k.label, scopes: k.scopes, limits: { per_minute: k.per_minute, per_day: k.per_day }, today: { requests: u.requests || 0, errors: u.errors || 0, rows: u.rows_returned || 0 }, expires_at: k.expires_at } };
  },

  /** Public HTML docs (no key needed). */
  async docs(ctx) {
    ctx.type = 'text/html; charset=utf-8';
    ctx.set('Cache-Control', 'public, max-age=300');
    ctx.body = require('../services/docs-html')();
  },
};
