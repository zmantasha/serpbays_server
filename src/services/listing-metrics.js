'use strict';

/**
 * Fill a new listing's metrics (2026-10-13).
 *
 * When a site is approved, its listing is created from what the publisher
 * typed, which is usually no DR or traffic at all, so buyers saw N/A even
 * though the Moderation checks had already fetched DR (Ahrefs) and traffic
 * (Ahrefs or DataForSEO). This copies those check values into the listing
 * (and the submission) wherever the listing has none. If there is no DR
 * check, it asks the free Ahrefs DR API. Never overwrites real values.
 */
async function fillListingMetrics(pwId) {
  const knex = strapi.db.connection;
  const pw = (await knex.raw('select id, url, marketplace_id from publisher_websites where id = ?', [pwId])).rows[0];
  if (!pw || !pw.marketplace_id) return { skipped: 'no listing' };
  const m = (await knex.raw('select id, url, ahrefs_dr, ahrefs_traffic from marketplaces where id = ?', [pw.marketplace_id])).rows[0];
  if (!m) return { skipped: 'listing missing' };
  const checks = Object.fromEntries((await knex.raw(`select key, value from moderation_checks where pw_id = ? and key in ('dr','traffic')`, [pwId])).rows
    .map((r) => [r.key, typeof r.value === 'string' ? JSON.parse(r.value) : r.value]));
  const listing = {}; const sub = {};
  const empty = (v) => v == null || Number(v) === 0;

  let dr = checks.dr && Number(checks.dr.dr);
  if (!(dr > 0)) {
    try {
      const k = await require('../api/admin/services/integration-keys').secretFor('ahrefs', 'AHREFS_API_KEY');
      const domain = String(pw.url).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (k && k.secret) {
        const r = await fetch(`https://api.ahrefs.com/v3/public/domain-rating-free?target=${encodeURIComponent(domain)}&output=json`, { headers: { Authorization: `Bearer ${k.secret}` }, signal: AbortSignal.timeout(8000) });
        if (r.ok) { const j = await r.json(); const v = j && j.domain_rating && j.domain_rating.domain_rating; if (v != null) dr = Number(v); }
      }
    } catch (_) { /* best effort */ }
  }
  if (dr > 0 && empty(m.ahrefs_dr)) { listing.ahrefs_dr = dr; listing.last_ahrefs_refresh_at = new Date(); sub.ahrefs_dr = dr; }

  const t = checks.traffic;
  if (t && Number(t.traffic) >= 0 && t.traffic != null && empty(m.ahrefs_traffic)) {
    listing.ahrefs_traffic = Math.round(Number(t.traffic));
    sub.ahrefs_traffic = listing.ahrefs_traffic;
    if (t.source === 'dataforseo') {
      listing.traffic_source = 'dataforseo';
      listing.dfs_traffic = listing.ahrefs_traffic;
      if (t.keywords != null) listing.dfs_keywords = Math.round(Number(t.keywords));
      listing.dfs_traffic_at = new Date();
    } else {
      listing.traffic_source = 'ahrefs';
    }
  }
  if (!Object.keys(listing).length) return { skipped: 'nothing to fill' };
  await strapi.db.query('api::marketplace.marketplace').update({ where: { id: m.id }, data: { ...listing, _audit: { source: 'approval-metrics', changedBy: 'system' } } });
  if (Object.keys(sub).length) await knex('publisher_websites').where({ id: pwId }).update(sub);
  strapi.log.info(`[listing-metrics] filled listing ${m.id} (${m.url}): ${Object.keys(listing).join(', ')}`);
  return { filled: listing };
}

module.exports = { fillListingMetrics };
