'use strict';

/**
 * GET /api/listing-facts?domain=finance.yahoo.com
 * -> { found: true, domain, guestPostPrice, linkInsertionPrice, dr, da, traffic,
 *      followType: 'dofollow' | 'nofollow' | 'sponsored' | 'ugc' | null, assured, tatDays }
 * Only ACTIVE listings, only fields buyers already see on the marketplace card.
 * Price 0/null means the service is not sold, so it comes back as null.
 */
const norm = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const FOLLOW = { 'do follow': 'dofollow', dofollow: 'dofollow', 'no follow': 'nofollow', nofollow: 'nofollow', sponsored: 'sponsored', ugc: 'ugc' };
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

module.exports = {
  async find(ctx) {
    const domain = norm(ctx.query.domain);
    if (!domain || domain.length > 253 || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return ctx.badRequest('domain is required');
    const knex = strapi.db.connection; // no literal ? in the SQL: knex treats it as a binding
    const res = await knex.raw(
      `select price, link_insertion_price, ahrefs_dr, moz_da, ahrefs_traffic, backlink_type, assured_placement, tat
         from marketplaces
        where status = 'active'
          and lower(regexp_replace(regexp_replace(url, '^https{0,1}://(www\\.){0,1}', ''), '/+$', '')) = ?
        order by assured_placement desc nulls last, id desc
        limit 1`, [domain]);
    const r = (res.rows || res)[0];
    ctx.set('Cache-Control', 'public, max-age=300');
    if (!r) return ctx.send({ found: false, domain });
    ctx.send({
      found: true,
      domain,
      guestPostPrice: money(r.price),
      linkInsertionPrice: money(r.link_insertion_price),
      dr: r.ahrefs_dr != null ? Number(r.ahrefs_dr) : null,
      da: r.moz_da != null ? Number(r.moz_da) : null,
      traffic: r.ahrefs_traffic != null ? Number(r.ahrefs_traffic) : null,
      followType: FOLLOW[String(r.backlink_type || '').trim().toLowerCase()] || null,
      assured: r.assured_placement === true,
      tatDays: Number(r.tat) > 0 ? Number(r.tat) : null,
    });
  },
};
