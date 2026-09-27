'use strict';

const { createCoreService } = require('@strapi/strapi').factories;
const UID = 'api::order-rating.order-rating';
const REVEAL_DAYS = 14;        // double-blind window after completion
const EDIT_HOURS = 24;
const TAGS = {
  advertiser: ['quality', 'communication', 'on_time'],          // advertiser rating the publisher
  publisher: ['clear_brief', 'responsive', 'reasonable_revisions'], // publisher rating the advertiser
};
const CONTACT_RE = /(\b[\w.+-]+@[\w-]+\.[\w.]+\b)|(\+?\d[\d\s().-]{8,}\d)|(whatsapp|telegram|skype|t\.me\/)/i;

module.exports = createCoreService(UID, ({ strapi }) => ({
  REVEAL_DAYS, EDIT_HOURS, TAGS,

  roleFor(order, userId) {
    if (order.advertiser?.id === userId) return 'advertiser';
    if (order.publisher?.id === userId) return 'publisher';
    return null;
  },

  /** Strip contact details from free-text comments (same rule as the chat). */
  cleanComment(text) {
    if (!text) return null;
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 500);
    return t.replace(CONTACT_RE, '[removed]');
  },

  /** Reveal both ratings when both sides have rated (double-blind). */
  async revealIfBoth(orderId) {
    const rows = await strapi.db.query(UID).findMany({ where: { order: orderId } });
    if (rows.length < 2 || rows.some((r) => r.visibleAt)) return false;
    for (const r of rows) await strapi.db.query(UID).update({ where: { id: r.id }, data: { visibleAt: new Date() } });
    for (const r of rows) await this.refreshPublisherSummary(r.id);
    return true;
  },

  /** Reveal ratings whose order completed more than REVEAL_DAYS ago (cron). */
  async revealExpired() {
    const cutoff = new Date(Date.now() - REVEAL_DAYS * 86400000);
    const rows = await strapi.db.query(UID).findMany({ where: { visibleAt: null, order: { completedDate: { $lt: cutoff } } }, populate: { order: { select: ['id'] } }, limit: 500 });
    for (const r of rows) { await strapi.db.query(UID).update({ where: { id: r.id }, data: { visibleAt: new Date() } }); await this.refreshPublisherSummary(r.id); }
    return rows.length;
  },

  /** Aggregate of VISIBLE ratings received by a user. */
  async summary(userId) {
    const knex = strapi.db.connection;
    const [agg] = await knex('order_ratings as r').join('order_ratings_ratee_lnk as l', 'l.order_rating_id', 'r.id')
      .where('l.user_id', userId).whereNotNull('r.visible_at')
      .select(knex.raw('count(*)::int as count'), knex.raw('round(avg(r.stars)::numeric, 2) as avg'), knex.raw("count(*) filter (where r.stars >= 4)::int as positive"));
    const tagRows = await knex('order_ratings as r').join('order_ratings_ratee_lnk as l', 'l.order_rating_id', 'r.id')
      .where('l.user_id', userId).whereNotNull('r.visible_at').whereNotNull('r.tags').select('r.tags');
    const tags = {};
    for (const row of tagRows) { const arr = Array.isArray(row.tags) ? row.tags : []; for (const t of arr) tags[t] = (tags[t] || 0) + 1; }
    const recent = await knex('order_ratings as r').join('order_ratings_ratee_lnk as l', 'l.order_rating_id', 'r.id')
      .where('l.user_id', userId).whereNotNull('r.visible_at').whereNotNull('r.comment').where('r.comment', '<>', '')
      .orderBy('r.visible_at', 'desc').limit(3).select('r.stars', 'r.comment', 'r.rater_role as raterRole', 'r.visible_at as at');
    return { userId: Number(userId), count: Number(agg?.count || 0), avg: agg?.avg != null ? Number(agg.avg) : null, positivePct: agg?.count ? Math.round((100 * Number(agg.positive)) / Number(agg.count)) : null, tags, recent };
  },

  /** Keep publisher_rating_avg/count on the publisher's listings in sync (used by rows + ranking later). */
  async refreshPublisherSummary(ratingId) {
    const r = await strapi.db.query(UID).findOne({ where: { id: ratingId }, populate: { ratee: { select: ['id'] } } });
    if (!r || r.raterRole !== 'advertiser' || !r.ratee) return; // only publisher ratings decorate listings
    const s = await this.summary(r.ratee.id);
    const knex = strapi.db.connection;
    await knex('marketplaces').whereIn('id', knex('marketplaces_publisher_lnk').select('marketplace_id').where('user_id', r.ratee.id))
      .update({ publisher_rating_avg: s.avg, publisher_rating_count: s.count });
  },

  /** Orders the user still has to rate (completed, within the window, no rating by them). */
  async pendingFor(userId, role) {
    const knex = strapi.db.connection;
    const lnk = role === 'advertiser' ? 'orders_advertiser_lnk' : 'orders_publisher_lnk';
    const cutoff = new Date(Date.now() - REVEAL_DAYS * 86400000);
    return knex('orders as o').join(`${lnk} as l`, 'l.order_id', 'o.id').leftJoin('orders_website_lnk as ow', 'ow.order_id', 'o.id').leftJoin('marketplaces as m', 'm.id', 'ow.marketplace_id')
      .where('l.user_id', userId).whereIn('o.order_status', ['completed', 'approved']).where('o.completed_date', '>', cutoff)
      .whereNotExists(knex('order_ratings as r').join('order_ratings_order_lnk as ro', 'ro.order_rating_id', 'r.id').join('order_ratings_rater_lnk as rr', 'rr.order_rating_id', 'r.id').whereRaw('ro.order_id = o.id').where('rr.user_id', userId))
      .select('o.id', 'o.completed_date as completedDate', 'o.total_amount as totalAmount', 'm.url as websiteUrl').orderBy('o.completed_date', 'desc').limit(20);
  },
}));
