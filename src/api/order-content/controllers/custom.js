'use strict';

/**
 * Custom order-content controller.
 *
 * GET /orders/:orderId/content
 *
 * Returns the order-content row for an order, gated to the parties of that
 * order: advertiser (FK), publisher (FK), OR — for legacy orders where the
 * publisher FK was never backfilled — a user whose email matches the order's
 * snapshot `websitePublisherEmail`. Returns 404 (not 403) on a cross-tenant
 * miss to prevent order-id enumeration via the differential.
 *
 * Only a fixed allow-list of scalar fields is returned. No populate of order
 * / advertiser / publisher / project — those carry PII and operational state
 * that does not belong in this response. Future schema additions are NOT
 * auto-exposed; they must be added here.
 */

const ORDER_CONTENT_PUBLIC_FIELDS = [
  'id', 'documentId',
  'title', 'content', 'url',
  'metaDescription', 'keywords',
  'anchorText', 'links', 'minWordCount',
  'createdAt', 'updatedAt', 'publishedAt',
];

function isPartyToOrder(order, user) {
  if (!order || !user || typeof user.id !== 'number') return false;
  if (order.advertiser && order.advertiser.id === user.id) return true;
  if (order.publisher && order.publisher.id === user.id) return true;
  // Snapshot-publisher fallback: only when the publisher FK is NOT set, fall
  // back to matching the snapshot email. Never let the snapshot override a
  // present FK (which is the authoritative ownership signal).
  if (!order.publisher?.id
      && order.websitePublisherEmail
      && user.email
      && order.websitePublisherEmail === user.email) {
    return true;
  }
  return false;
}

module.exports = {
  async getOrderContent(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to view order content');
      }

      const { orderId } = ctx.params;
      const numericOrderId = Number(orderId);
      if (!Number.isInteger(numericOrderId) || numericOrderId <= 0) {
        return ctx.notFound('Order content not found');
      }

      const order = await strapi.entityService.findOne('api::order.order', numericOrderId, {
        fields: ['id', 'websitePublisherEmail'],
        populate: {
          advertiser:  { fields: ['id'] },
          publisher:   { fields: ['id'] },
        },
      });

      // Collapse "not found" and "not yours" into a single 404 so an
      // attacker cannot enumerate which order IDs exist by probing.
      if (!order || !isPartyToOrder(order, ctx.state.user)) {
        return ctx.notFound('Order content not found');
      }

      const content = await strapi.db.query('api::order-content.order-content').findOne({
        where: { order: numericOrderId },
        select: ORDER_CONTENT_PUBLIC_FIELDS,
      });

      if (!content) {
        return ctx.notFound('No content found for this order');
      }

      return content;
    } catch (error) {
      strapi.log?.error?.('[order-content] getOrderContent failed', { error: error.message });
      return ctx.badRequest('Failed to get order content');
    }
  },
};
