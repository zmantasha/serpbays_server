'use strict';

// Ratings (2026-09-27): reveal after the double-blind window; remind unrated sides once at day 7.
module.exports = {
  ratingVisibility: {
    task: async ({ strapi }) => {
      try {
        const svc = strapi.service('api::order-rating.order-rating');
        const revealed = await svc.revealExpired();
        const knex = strapi.db.connection;
        const due = await knex('orders as o').whereIn('o.order_status', ['completed', 'approved']).whereBetween('o.completed_date', [new Date(Date.now() - 8 * 86400000), new Date(Date.now() - 7 * 86400000)])
          .leftJoin('orders_advertiser_lnk as oa', 'oa.order_id', 'o.id').leftJoin('orders_publisher_lnk as op', 'op.order_id', 'o.id').select('o.id', 'oa.user_id as adv', 'op.user_id as pub');
        let reminded = 0;
        for (const o of due) {
          for (const [uid, role] of [[o.adv, 'advertiser'], [o.pub, 'publisher']]) {
            if (!uid) continue;
            const has = await strapi.db.query('api::order-rating.order-rating').findOne({ where: { order: o.id, rater: uid } });
            if (has) continue;
            const url = role === 'advertiser' ? `/orders/order-detail/${o.id}#rating` : `/publisher/order-detail/${o.id}#rating`;
            try { await strapi.service('api::notification.notification').createNotification({ recipientId: uid, type: 'order', action: 'order_completed', title: `Rate order #${o.id}`, message: 'One week left to rate how this order went. It takes 10 seconds and helps everyone choose better partners.', relatedOrderId: o.id, data: { url } }); reminded++; } catch (e) { /* non-fatal */ }
          }
        }
        if (revealed || reminded) console.log(`[Ratings Cron] revealed=${revealed} reminded=${reminded}`);
      } catch (e) { console.error('[Ratings Cron] failed:', e.message); }
    },
    options: { rule: '40 * * * *' }, // hourly
  },
};
