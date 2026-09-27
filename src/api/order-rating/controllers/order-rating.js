'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const UID = 'api::order-rating.order-rating';

const pub = (r, mine) => ({ id: r.id, raterRole: r.raterRole, stars: r.stars, tags: Array.isArray(r.tags) ? r.tags : [], comment: r.comment || null, createdAt: r.createdAt, visibleAt: r.visibleAt, mine, editableUntil: mine ? new Date(new Date(r.createdAt).getTime() + 24 * 3600000) : undefined });

module.exports = createCoreController(UID, ({ strapi }) => ({
  async loadOrder(ctx) {
    const id = parseInt(ctx.params.id, 10);
    if (!Number.isFinite(id)) return null;
    return strapi.db.query('api::order.order').findOne({ where: { id }, select: ['id', 'orderStatus', 'completedDate'], populate: { advertiser: { select: ['id', 'email', 'firstName'] }, publisher: { select: ['id', 'email', 'firstName'] } } });
  },

  /** POST /orders/:id/rating { stars, tags[], comment } */
  async submit(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service(UID);
    const order = await this.loadOrder(ctx); if (!order) return ctx.notFound('Order not found.');
    const role = svc.roleFor(order, user.id); if (!role) return ctx.forbidden('Only the advertiser or publisher of this order can rate it.');
    if (!['completed', 'approved'].includes(order.orderStatus)) return ctx.badRequest('You can rate an order once it is completed.');
    const b = ctx.request.body || {};
    const stars = parseInt(b.stars, 10); if (!(stars >= 1 && stars <= 5)) return ctx.badRequest('Stars must be 1 to 5.');
    const allowed = svc.TAGS[role]; const tags = (Array.isArray(b.tags) ? b.tags : []).filter((t) => allowed.includes(t)).slice(0, 3);
    const comment = svc.cleanComment(b.comment);
    const ratee = role === 'advertiser' ? order.publisher : order.advertiser; if (!ratee) return ctx.badRequest('This order has no counterparty to rate.');
    const existing = await strapi.db.query(UID).findOne({ where: { order: order.id, rater: user.id } });
    let row;
    if (existing) {
      if (Date.now() - new Date(existing.createdAt).getTime() > svc.EDIT_HOURS * 3600000) return ctx.badRequest('Ratings can be edited for 24 hours after submission.');
      row = await strapi.db.query(UID).update({ where: { id: existing.id }, data: { stars, tags, comment } });
    } else {
      row = await strapi.entityService.create(UID, { data: { order: order.id, rater: user.id, ratee: ratee.id, raterRole: role, stars, tags, comment } });
      const revealed = await svc.revealIfBoth(order.id);
      strapi.log.info(`[rating] order #${order.id}: ${role} ${user.id} rated ${ratee.id} ${stars}★${revealed ? ' (both in — revealed)' : ''}`);
      if (revealed) {
        for (const u of [order.advertiser, order.publisher]) {
          try { await strapi.service('api::notification.notification').createNotification({ recipientId: u.id, type: 'order', action: 'order_completed', title: `Ratings for order #${order.id} are in`, message: 'Both sides have rated — open the order to see how it went.', relatedOrderId: order.id }); } catch (e) { /* non-fatal */ }
        }
      }
    }
    if (row.visibleAt) await svc.refreshPublisherSummary(row.id);
    ctx.body = { data: pub(row, true) };
  },

  /** GET /orders/:id/ratings → mine (always) + theirs (only once visible) + window info */
  async forOrder(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service(UID);
    const order = await this.loadOrder(ctx); if (!order) return ctx.notFound('Order not found.');
    const role = svc.roleFor(order, user.id); if (!role) return ctx.forbidden();
    const rows = await strapi.db.query(UID).findMany({ where: { order: order.id }, populate: { rater: { select: ['id'] } } });
    const mine = rows.find((r) => r.rater?.id === user.id) || null;
    const theirs = rows.find((r) => r.rater?.id !== user.id) || null;
    const completedAt = order.completedDate ? new Date(order.completedDate) : null;
    const revealAt = completedAt ? new Date(completedAt.getTime() + svc.REVEAL_DAYS * 86400000) : null;
    ctx.body = { data: { role, canRate: ['completed', 'approved'].includes(order.orderStatus), tags: svc.TAGS[role], mine: mine ? pub(mine, true) : null, theirs: theirs && theirs.visibleAt ? pub(theirs, false) : null, theirsSubmitted: !!theirs, revealAt, counterparty: role === 'advertiser' ? { id: order.publisher?.id } : { id: order.advertiser?.id } } };
  },

  /** GET /ratings/summary/:userId — public aggregate of visible ratings */
  async summary(ctx) {
    const id = parseInt(ctx.params.userId, 10); if (!Number.isFinite(id)) return ctx.badRequest();
    ctx.body = { data: await strapi.service(UID).summary(id) };
  },

  /** GET /ratings/pending — orders the caller should rate (for prompts) */
  async pending(ctx) {
    const user = ctx.state.user; if (!user) return ctx.unauthorized();
    const svc = strapi.service(UID);
    const role = user.Advertiser === false || user.Publisher === true ? 'publisher' : 'advertiser';
    const [asRole, asOther] = await Promise.all([svc.pendingFor(user.id, role), svc.pendingFor(user.id, role === 'advertiser' ? 'publisher' : 'advertiser')]);
    ctx.body = { data: [...asRole, ...asOther].slice(0, 20) };
  },
}));
