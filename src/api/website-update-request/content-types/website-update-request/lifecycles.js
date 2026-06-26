'use strict';

/**
 * Website-update-request lifecycle — real-time push.
 *
 * Closes Gap 2 from the final wiring-coverage audit. Previously:
 *   - Publisher edits an approved website → WUR created (status=pending),
 *     publisher's my-websites page shows no badge change until refresh
 *   - Admin approves/rejects in panel20 → WUR transitions, publisher
 *     stays on the stale view, admin queue doesn't tick when a sibling
 *     admin approves another request
 *
 * Now:
 *   - afterCreate fires `website_update_request:status_changed` on the
 *     publisher's user channel + `admin:website_update_event` on admins
 *     room
 *   - afterUpdate fires the same pair on every status transition,
 *     gated on `params.data.status` so non-status edits (notes, etc.)
 *     don't spam
 */
module.exports = {
  async afterCreate(event) {
    try {
      const { result } = event;
      if (!result?.id) return;
      await strapi.service('api::website-update-request.website-update-request')
        .emitStatusChanged(result, null, { lifecycle: 'afterCreate' });
    } catch (err) {
      strapi.log?.warn?.(`[WUR lifecycle] afterCreate emit failed: ${err.message}`);
    }
  },

  async afterUpdate(event) {
    try {
      const { result, params } = event;
      if (!result?.id) return;
      const dataHadStatus = params?.data && Object.prototype.hasOwnProperty.call(params.data, 'status');
      if (!dataHadStatus) return;
      await strapi.service('api::website-update-request.website-update-request')
        .emitStatusChanged(result, null, { lifecycle: 'afterUpdate' });
    } catch (err) {
      strapi.log?.warn?.(`[WUR lifecycle] afterUpdate emit failed: ${err.message}`);
    }
  },
};
