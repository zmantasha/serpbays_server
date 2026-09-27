'use strict';

// Unanswered-message reminder (2026-09-27): if the last message on an active order
// has had no reply for 24h (and < 72h), nudge the other party once. Single instance only.
module.exports = {
  chatUnansweredReminders: {
    task: async ({ strapi }) => {
      try {
        const knex = strapi.db.connection;
        const rows = await knex.raw(`
          WITH last AS (
            SELECT DISTINCT ON (co.order_id) co.order_id, c.id AS comm_id, cs.user_id AS sender_id, c.created_at, c.reminder_sent_at
            FROM communications c JOIN communications_order_lnk co ON co.communication_id = c.id JOIN communications_sender_lnk cs ON cs.communication_id = c.id
            ORDER BY co.order_id, c.created_at DESC)
          SELECT l.order_id, l.comm_id, l.sender_id, o.order_status, oa.user_id AS advertiser_id, op.user_id AS publisher_id, m.url
          FROM last l JOIN orders o ON o.id = l.order_id LEFT JOIN orders_advertiser_lnk oa ON oa.order_id = o.id LEFT JOIN orders_publisher_lnk op ON op.order_id = o.id LEFT JOIN orders_website_lnk ow ON ow.order_id = o.id LEFT JOIN marketplaces m ON m.id = ow.marketplace_id
          WHERE o.order_status IN ('pending','accepted','delivered') AND l.reminder_sent_at IS NULL AND l.created_at < now() - interval '24 hours' AND l.created_at > now() - interval '72 hours'`);
        let sent = 0;
        for (const r of rows.rows) {
          const other = r.sender_id === r.advertiser_id ? r.publisher_id : r.sender_id === r.publisher_id ? r.advertiser_id : null;
          if (!other) continue;
          const url = other === r.advertiser_id ? `/orders/order-detail/${r.order_id}#conversation` : `/publisher/order-detail/${r.order_id}#conversation`;
          try { await strapi.service('api::notification.notification').createNotification({ recipientId: other, type: 'communication', action: 'message_received', title: `Unanswered message on order #${r.order_id}`, message: `${r.url ? r.url + ': ' : ''}a message from the other side has been waiting for a day. A quick reply keeps the order moving.`, relatedOrderId: r.order_id, data: { url } }); } catch (e) { /* non-fatal */ }
          try { const u = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: other }, select: ['email', 'firstName'] }); if (u?.email) await strapi.service('api::global.autosend-service').send({ to: u.email, subject: `Reply needed on order #${r.order_id}`, html: `<p>Hi ${u.firstName || ''},</p><p>There is an unanswered message on order <b>#${r.order_id}</b>${r.url ? ` (${r.url})` : ''} from yesterday.</p><p><a href="${(process.env.CLIENT_URL || 'https://app.serpbays.com').replace(/\/$/, '')}${url}">Open the conversation</a></p><p>— SerpBays</p>`, tags: ['transactional', 'chat'] }); } catch (e) { /* email optional */ }
          await knex('communications').where('id', r.comm_id).update({ reminder_sent_at: new Date() });
          sent++;
        }
        if (sent) console.log(`[Chat Reminders] sent ${sent}`);
      } catch (e) { console.error('[Chat Reminders] failed:', e.message); }
    },
    options: { rule: '10 * * * *' }, // hourly
  },
};
