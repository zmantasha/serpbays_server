'use strict';

/**
 * publisher-website service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::publisher-website.publisher-website', ({ strapi }) => ({
  /**
   * Link every website that carries `email` but has no current owner to
   * `userId`.
   *
   * Why this exists (2026-09-24): websites added on a publisher's behalf
   * before they had an account carry only their email. The read path used
   * to cover that with an OR ("linked to me" OR "no owner AND email is
   * mine") on every page load, which spans a relation and a column and so
   * forced a full scan of publisher_websites + its link table three times
   * per request (~0.45s for everyone, regardless of how many sites they
   * own). Linking at login time lets find() use a single indexed lookup.
   *
   * Writes the link rows directly, bypassing lifecycles on purpose:
   * afterUpdate creates marketplace listings on approval and must not fire
   * for a pure ownership backfill. Idempotent (ON CONFLICT DO NOTHING).
   * Matches the email exactly, as the old read-time filter did.
   */
  async linkOwnerlessWebsitesByEmail(userId, email) {
    if (!userId || !email) return 0;
    const knex = strapi.db.connection;
    const L = 'publisher_websites_current_publisher_id_lnk';
    const rows = await knex('publisher_websites as pw')
      .select('pw.id')
      .where('pw.publisher_email', email)
      .whereNotExists(knex(L).whereRaw('publisher_website_id = pw.id'))
      .limit(1000);
    if (rows.length === 0) return 0;
    await knex(L)
      .insert(rows.map((r) => ({ publisher_website_id: r.id, user_id: userId })))
      .onConflict(['publisher_website_id', 'user_id'])
      .ignore();
    strapi.log.info(`[publisher-website] linked ${rows.length} ownerless website(s) carrying ${email} to user ${userId}`);
    return rows.length;
  },
}));




