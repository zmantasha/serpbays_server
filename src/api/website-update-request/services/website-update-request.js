'use strict';

/**
 * website-update-request service
 */

const { createCoreService } = require('@strapi/strapi').factories;
const seq = require('../../../utils/realtime-seq')('website_update_request');

module.exports = createCoreService('api::website-update-request.website-update-request', ({ strapi }) => ({
  /**
   * Real-time push for a website-update-request transition.
   *
   * The publisher's `/publisher/my-websites` page shows a "pending review"
   * / "rejected" badge per site that previously went stale until manual
   * refresh. The panel20 `/website-updates` admin queue page also went
   * stale when a new pending request arrived.
   *
   * Two emits per transition:
   *   1. `website_update_request:status_changed` on the requesting
   *      publisher's user channel — drives my-websites refresh.
   *   2. `admin:website_update_event` on the admins room — drives the
   *      panel20 queue + a navbar badge if any.
   *
   * The publisher is resolved through the `publisherWebsite` relation
   * (the WUR doesn't carry a direct user FK — publisherWebsite owns
   * `currentPublisherId`).
   */
  async emitStatusChanged(requestOrId, previousStatus, meta = {}) {
    try {
      if (!strapi.io || typeof strapi.io.emitToUser !== 'function') return;

      const id = typeof requestOrId === 'object' ? requestOrId.id : requestOrId;
      if (!id) return;

      const request = await strapi.entityService.findOne(
        'api::website-update-request.website-update-request',
        id,
        {
          populate: {
            publisherWebsite: { populate: ['currentPublisherId'] },
            marketplace: true,
          },
        }
      );
      if (!request) return;

      const publisherId = request.publisherWebsite?.currentPublisherId?.id || null;
      const occurredAt = new Date().toISOString();

      const basePayload = {
        type: 'website_update_request:status_changed',
        requestId: request.id,
        status: request.status,
        previousStatus: previousStatus || null,
        marketplaceId: request.marketplace?.id || null,
        publisherWebsiteId: request.publisherWebsite?.id || null,
        occurredAt,
        meta: meta || {},
      };

      if (publisherId) {
        strapi.io.emitToUser(publisherId, 'website_update_request:status_changed', {
          ...basePayload,
          seq: await seq.next(publisherId),
        });
      }

      // Admin fan-out — every admin watching /website-updates sees new
      // requests pop and status transitions flip live.
      if (typeof strapi.io.emitToAdmins === 'function') {
        strapi.io.emitToAdmins('admin:website_update_event', {
          ...basePayload,
          publisherId,
        });
      }
    } catch (err) {
      strapi.log?.warn?.(`[WUR] emitStatusChanged failed (non-fatal): ${err.message}`);
    }
  },
}));
