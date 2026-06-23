'use strict';

/**
 * Order lifecycle — real-time push.
 *
 * Hooks into create + status-changing updates and emits
 * `order:status_changed` on both parties' Socket.IO rooms via the order
 * service's `emitOrderUpdate` helper. This is the chokepoint: every code
 * path that mutates `orderStatus` (controller methods, service methods,
 * cron jobs, admin actions, etc.) goes through Strapi's entity layer, so
 * a lifecycle here covers them all without sprinkling emit calls at 12+
 * sites.
 *
 * - afterCreate: always emit (every new order starts at `pending` and the
 *   advertiser needs to see it in their "my orders" list).
 * - afterUpdate: emit only when the update changed `orderStatus`. Other
 *   field mutations (notes, dates without a status change) shouldn't
 *   spam the channel.
 *
 * Best-effort: emit failures are caught by the service helper itself and
 * never break the underlying create/update.
 */
module.exports = {
  async afterCreate(event) {
    try {
      const { result } = event;
      if (!result?.id) return;
      await strapi.service('api::order.order').emitOrderUpdate(
        result,
        'created',
        { initialStatus: result.orderStatus || 'pending' }
      );

      // Marketplace broadcast: a brand-new pending order with no publisher
      // assigned is invisible to per-user channels (no publisher.id to
      // route to). Without this, every publisher's available-orders page
      // sits on its `staleTime: 30000` window before they realize a new
      // job appeared. Broadcasting to the `publishers` room lets each
      // publisher's client invalidate its `availableOrders` query
      // immediately. Gated on no publisher relation so we don't fire
      // for direct-assigned orders (which already hit the publisher
      // channel via the regular emitOrderUpdate above).
      try {
        if (typeof strapi.io?.emitToPublishers === 'function') {
          // Reload with the publisher relation so we know whether to fire.
          const fresh = await strapi.entityService.findOne('api::order.order', result.id, {
            populate: ['publisher'],
          });
          if (fresh && !fresh.publisher?.id) {
            strapi.io.emitToPublishers('order:created_for_marketplace', {
              type: 'order:created_for_marketplace',
              orderId: fresh.id,
              websiteUrl: fresh.websiteUrl || null,
              totalAmount: fresh.totalAmount != null ? Number(fresh.totalAmount) : null,
              occurredAt: new Date().toISOString(),
            });
          }
        }
      } catch (broadcastErr) {
        strapi.log?.warn?.(`[Order lifecycle] marketplace broadcast failed (non-fatal): ${broadcastErr.message}`);
      }
    } catch (err) {
      strapi.log?.warn?.(`[Order lifecycle] afterCreate emit failed (non-fatal): ${err.message}`);
    }
  },

  async afterUpdate(event) {
    try {
      const { result, params } = event;
      if (!result?.id) return;
      // Emit only on real status transitions. Other field-only updates
      // (deliveryNotes, currency, etc.) don't need a push.
      const dataHadStatus = params?.data && Object.prototype.hasOwnProperty.call(params.data, 'orderStatus');
      if (!dataHadStatus) return;
      await strapi.service('api::order.order').emitOrderUpdate(
        result,
        params.data.orderStatus || 'unspecified',
        { lifecycle: 'afterUpdate' }
      );
    } catch (err) {
      strapi.log?.warn?.(`[Order lifecycle] afterUpdate emit failed (non-fatal): ${err.message}`);
    }
  },
};
