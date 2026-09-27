'use strict';

/**
 * Auto-approval of delivered orders (2026-09-27).
 *
 * Global Config has had `autoApproveDays` (default 5) for months, but nothing
 * consumed it: a delivered order stayed "delivered" until the advertiser
 * clicked Approve, and six orders sat in escrow for 2–6 months. This service
 * closes that gap and is called by the daily cron and by the admin "run now"
 * endpoint (dry-run capable).
 *
 * Rules:
 *  - candidate = orderStatus 'delivered', deliveredDate older than N days,
 *    no open revision (revisionStatus null or 'completed').
 *  - completion goes through orderService.completeOrder — the exact call the
 *    advertiser's Approve button makes — so escrow release, publisher payout
 *    and wallet transactions are identical. Then the same notifications.
 *  - reminder to the advertiser 2 days before the deadline (once, tracked by
 *    autoApproveReminderSentAt).
 */

const SYSTEM_ACTOR = { id: null, email: 'system', username: 'system' };
const DAY = 86400000;
const appUrl = () => (process.env.CLIENT_URL || 'https://app.serpbays.com').replace(/\/$/, '');

module.exports = ({ strapi }) => ({
  async config() {
    const cfg = await strapi.db.query('api::global-config.global-config').findOne({});
    const days = Math.max(1, parseInt(cfg?.autoApproveDays, 10) || 5);
    return { days, remindAfterDays: Math.max(1, days - 2) };
  },

  async candidates(days) {
    const cutoff = new Date(Date.now() - days * DAY);
    const rows = await strapi.db.query('api::order.order').findMany({
      where: { orderStatus: 'delivered', deliveredDate: { $lt: cutoff }, $or: [{ revisionStatus: null }, { revisionStatus: 'completed' }] },
      populate: ['advertiser', 'publisher', 'website'], orderBy: { deliveredDate: 'asc' }, limit: 200,
    });
    return rows;
  },

  async email(to, subject, html) {
    try { await strapi.service('api::global.autosend-service').send({ to, subject, html, tags: ['transactional', 'order'] }); return true; }
    catch (e) { strapi.log.warn(`[auto-approve] email "${subject}" to ${to} not delivered: ${e.message}`); return false; }
  },

  /** @param {{dryRun?: boolean}} opts */
  async run(opts = {}) {
    const dryRun = !!opts.dryRun;
    const { days, remindAfterDays } = await this.config();
    const orderService = strapi.service('api::order.order');
    const notif = strapi.service('api::notification.notification');
    const emailOps = strapi.service('api::global.email-operations');
    const result = { dryRun, days, completed: [], reminded: [], errors: [] };

    // 1) complete overdue deliveries
    const due = await this.candidates(days);
    for (const o of due) {
      const entry = { id: o.id, site: o.website?.url || null, deliveredDate: o.deliveredDate, amount: o.totalAmount, advertiser: o.advertiser?.email || null, publisher: o.publisher?.email || null };
      if (dryRun) { result.completed.push(entry); continue; }
      try {
        const reason = `Auto-approved: no response from advertiser within ${days} days of delivery`;
        const completedOrder = await orderService.completeOrder(o.id, SYSTEM_ACTOR);
        await strapi.db.query('api::order.order').update({ where: { id: o.id }, data: { autoApproved: true } });
        try { await orderService.createAuditLog(o, 'completed', null, reason); } catch (e) { strapi.log.warn(`[auto-approve] audit #${o.id}: ${e.message}`); }
        const pubId = o.publisher?.id, advId = o.advertiser?.id;
        try { if (pubId) await notif.createOrderNotification(o.id, pubId, advId || null, 'order_completed'); } catch (e) { strapi.log.warn(`[auto-approve] notif #${o.id}: ${e.message}`); }
        try { if (pubId) await notif.createPaymentNotification(pubId, 'payment_received', o.totalAmount); } catch (e) { strapi.log.warn(`[auto-approve] pay notif #${o.id}: ${e.message}`); }
        try { if (o.publisher?.email) await emailOps.sendOrderCompletionEmail(completedOrder || o, o.publisher.email, o.totalAmount); } catch (e) { strapi.log.warn(`[auto-approve] publisher email #${o.id}: ${e.message}`); }
        try {
          if (advId) await notif.createNotification({ recipientId: advId, type: 'order', action: 'order_completed', title: `Order #${o.id} auto-approved`, message: `The delivery for ${entry.site || 'your order'} was approved automatically after ${days} days without a response.`, relatedOrderId: o.id });
          if (o.advertiser?.email) this.email(o.advertiser.email, `Order #${o.id} was approved automatically`, `<p>Hi ${o.advertiser.firstName || ''},</p><p>Your order <b>#${o.id}</b>${entry.site ? ` on <b>${entry.site}</b>` : ''} was delivered on ${new Date(o.deliveredDate).toDateString()}. As no approval or revision request was received within ${days} days, it has been approved automatically and the publisher has been paid.</p><p><a href="${appUrl()}/orders/order-detail/${o.id}">View the order</a></p><p>— SerpBays</p>`);
        } catch (e) { strapi.log.warn(`[auto-approve] advertiser notice #${o.id}: ${e.message}`); }
        strapi.log.info(`[auto-approve] order #${o.id} completed (${entry.site}, $${o.totalAmount})`);
        result.completed.push(entry);
      } catch (e) {
        strapi.log.error(`[auto-approve] order #${o.id} FAILED: ${e.message}`);
        result.errors.push({ id: o.id, error: e.message });
      }
    }

    // 2) remind advertisers 2 days before the deadline (once)
    const remindCutoff = new Date(Date.now() - remindAfterDays * DAY);
    const toRemind = await strapi.db.query('api::order.order').findMany({
      where: { orderStatus: 'delivered', deliveredDate: { $lt: remindCutoff }, autoApproveReminderSentAt: null, $or: [{ revisionStatus: null }, { revisionStatus: 'completed' }] },
      populate: ['advertiser', 'website'], limit: 200,
    });
    for (const o of toRemind) {
      if (result.completed.some((c) => c.id === o.id)) continue;
      const deadline = new Date(new Date(o.deliveredDate).getTime() + days * DAY);
      const entry = { id: o.id, site: o.website?.url || null, advertiser: o.advertiser?.email || null, deadline };
      if (dryRun) { result.reminded.push(entry); continue; }
      try {
        if (o.advertiser?.id) await notif.createNotification({ recipientId: o.advertiser.id, type: 'order', action: 'order_delivered', title: `Please review order #${o.id}`, message: `Approve the delivery or request a revision by ${deadline.toDateString()} — otherwise it is approved automatically.`, relatedOrderId: o.id });
        if (o.advertiser?.email) await this.email(o.advertiser.email, `Action needed: review order #${o.id} by ${deadline.toDateString()}`, `<p>Hi ${o.advertiser.firstName || ''},</p><p>Your order <b>#${o.id}</b>${entry.site ? ` on <b>${entry.site}</b>` : ''} has been delivered and is waiting for your review.</p><p>Please approve it or request a revision by <b>${deadline.toDateString()}</b>. If we don't hear from you, the order is approved automatically and the publisher is paid.</p><p><a href="${appUrl()}/orders/order-detail/${o.id}">Review the order</a></p><p>— SerpBays</p>`);
        await strapi.db.query('api::order.order').update({ where: { id: o.id }, data: { autoApproveReminderSentAt: new Date() } });
        result.reminded.push(entry);
      } catch (e) { result.errors.push({ id: o.id, error: `reminder: ${e.message}` }); }
    }
    strapi.log.info(`[auto-approve] run${dryRun ? ' (dry)' : ''}: ${result.completed.length} completed, ${result.reminded.length} reminded, ${result.errors.length} errors`);
    return result;
  },
});
