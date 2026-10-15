'use strict';

/**
 * GSC-verified sites are Assured (2026-10-15, asked by Vinayak).
 *
 * Every live listing whose publisher proved ownership with Google Search
 * Console gets the "Assured Placement" badge. GSC status is set from several
 * places (publisher verify flow, admin add/edit, sync, transfers), so instead
 * of hooking each one this sweep runs every few minutes from cron.
 *
 * It only touches listings nobody has decided on yet (assured_at IS NULL).
 * If an admin ever turned Assured off for a site, that decision stands and the
 * sweep leaves it alone. Each change goes through entityService (listing
 * history) and gets an admin audit log row, like the manual toggle.
 */
const NOTE = 'Auto: owner verified via Google Search Console';

async function sweep() {
  const knex = strapi.db.connection;
  const res = await knex.raw(`
    select distinct m.id, m.url
      from marketplaces m
      join publisher_websites pw on pw.marketplace_id = m.id
     where m.status = 'active'
       and coalesce(m.assured_placement, false) = false
       and m.assured_at is null
       and (coalesce(pw.gsc_verified, false) or pw.verification_method = 'google-search-console')
     order by m.id
     limit 200`);
  const rows = res.rows || res;
  let marked = 0;
  for (const r of rows) {
    try {
      await strapi.entityService.update('api::marketplace.marketplace', r.id, {
        data: {
          assured_placement: true, assured_note: NOTE, assured_at: new Date(), assured_by: 'system (GSC rule)',
          _audit: { source: 'system', userId: null, changedBy: 'system (GSC rule)' },
        },
      });
      await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
        data: {
          action: 'assured_placement',
          details: { marketplaceId: r.id, url: r.url, from: false, to: true, note: NOTE, auto: true },
          createdAt: new Date(), updatedAt: new Date(),
        },
      }).catch((e) => strapi.log.warn(`[gsc-assured] audit log failed: ${e.message}`));
      marked += 1;
    } catch (e) {
      strapi.log.warn(`[gsc-assured] listing ${r.id} failed: ${e.message}`);
    }
  }
  if (marked) strapi.log.info(`[gsc-assured] marked ${marked} GSC-verified listing(s) Assured`);
  return { checked: rows.length, marked };
}

module.exports = { sweep };
