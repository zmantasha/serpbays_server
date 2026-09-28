'use strict';

/**
 * publisher-website service
 */

const { createCoreService } = require('@strapi/strapi').factories;


/**
 * Terms an order was actually sold on. A listing edit is only worth telling the
 * advertiser about when it moves one of these AWAY from what their order says.
 * Price/category/language are deliberately absent: the order locked its price at
 * checkout and the rest do not change what gets delivered.
 *
 * `read` pulls the equivalent value off the order; `label` is what the
 * advertiser sees; `format` renders a value for the message.
 */
const ORDER_TERMS = {
  backlink_type:     { label: 'link type',      read: (o) => o.websiteBacklinkType },
  backlink_validity: { label: 'link validity',  read: (o) => o.websiteBacklinkValidity,
                       same: (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '') },
  dofollow_link:     { label: 'links per post', read: (o) => o.websiteDofollowLink },
  // marketplace.tat is DAYS, the order stores HOURS
  tat:               { label: 'turnaround',     read: (o) => o.websiteTat, toLive: (h) => Math.ceil((Number(h) || 0) / 24),
                       format: (d) => `${d} day${Number(d) === 1 ? '' : 's'}` },
  min_word_count:    { label: 'minimum words',  read: (o) => o.websiteMinWordCount },
  guidelines:        { label: 'guidelines',     read: (o) => o.websiteGuidelines, brief: true },
  sponsored:         { label: 'sponsored tag',  read: (o) => o.websiteSnapshot?.sponsored, format: (v) => (v ? 'on' : 'off') },
  ugc:               { label: 'UGC tag',        read: (o) => o.websiteSnapshot?.ugc, format: (v) => (v ? 'on' : 'off') },
};

const ACTIVE_ORDER_STATUSES = ['pending', 'accepted', 'delivered', 'disputed'];

module.exports = createCoreService('api::publisher-website.publisher-website', ({ strapi }) => ({
  /**
   * Tell advertisers with a live order on this site that its listing changed.
   *
   * The order is NOT modified: it keeps the terms it was placed on, and the
   * publisher is expected to deliver those. This only removes the surprise —
   * the advertiser sees what moved and is pointed at the order chat to confirm.
   * Called from both edit paths: the fields that apply immediately, and the
   * ones an admin approves later.
   *
   * @param {number} marketplaceId
   * @param {object} appliedChanges  marketplace field -> its NEW value
   */
  async notifyActiveOrdersOfListingChange(marketplaceId, appliedChanges) {
    try {
      const fields = Object.keys(appliedChanges || {}).filter((f) => ORDER_TERMS[f]);
      if (fields.length === 0) return 0;

      const orders = await strapi.db.query('api::order.order').findMany({
        where: { website: marketplaceId, orderStatus: { $in: ACTIVE_ORDER_STATUSES } },
        populate: { advertiser: { select: ['id'] } },
      });
      if (orders.length === 0) return 0;

      let sent = 0;
      for (const order of orders) {
        const advertiserId = order.advertiser?.id;
        if (!advertiserId) continue;

        const moved = [];
        for (const field of fields) {
          const term = ORDER_TERMS[field];
          const wasRaw = term.read(order);
          const was = term.toLive ? term.toLive(wasRaw) : wasRaw;
          const now = appliedChanges[field];
          if (was === undefined || was === null) continue;      // nothing to compare against
          const same = term.same ? term.same(was, now) : String(was) === String(now);
          if (same) continue;
          const show = term.format || ((v) => String(v));
          moved.push(term.brief ? `${term.label} were edited` : `${term.label}: ${show(was)} → ${show(now)}`);
        }
        if (moved.length === 0) continue;

        const listed = moved.slice(0, 3).join(', ');
        const more = moved.length > 3 ? ` and ${moved.length - 3} more` : '';

        await strapi.service('api::notification.notification').createNotification({
          recipientId: advertiserId,
          title: 'Listing changed after you ordered',
          message: `The publisher updated this website after your order — ${listed}${more}. Your order is unaffected and still carries the terms you bought. If you want to be sure, confirm it with the publisher in the order chat.`,
          type: 'order',
          action: 'system_update',
          relatedOrderId: order.id,
          // the call to action is "ask the publisher", so the click lands in
          // the order's conversation rather than on the order page
          data: { url: `/messages?order=${order.id}`, changedTerms: moved, marketplaceId },
        });
        sent += 1;
      }

      if (sent > 0) {
        strapi.log.info(`[listing-change] notified ${sent} advertiser(s) with a live order on marketplace ${marketplaceId} (${fields.join(', ')})`);
      }
      return sent;
    } catch (e) {
      // Never let a notification failure roll back the listing edit itself.
      strapi.log.error(`[listing-change] advertiser notification failed for marketplace ${marketplaceId}: ${e.message}`);
      return 0;
    }
  },

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




