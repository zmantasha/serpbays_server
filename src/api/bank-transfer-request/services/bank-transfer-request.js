'use strict';

/**
 * bank-transfer-request service
 */

const { createCoreService } = require('@strapi/strapi').factories;
const seq = require('../../../utils/realtime-seq')('bank_transfer');

module.exports = createCoreService('api::bank-transfer-request.bank-transfer-request', ({ strapi }) => ({
  /**
   * Real-time push: emit `bank_transfer:status_changed` on the requester's
   * channel so the user's wallet / requests page re-renders when an admin
   * approves or rejects their offline payment. Best-effort.
   *
   * The wallet emit for the actual credit fires separately from the
   * controller (already added in pass 2).
   */
  async emitBankTransferStatusChanged(requestOrId, previousStatus, meta = {}) {
    try {
      if (!strapi.io || typeof strapi.io.emitToUser !== 'function') return;

      const id = typeof requestOrId === 'object' ? requestOrId.id : requestOrId;
      if (!id) return;

      const request = await strapi.entityService.findOne(
        'api::bank-transfer-request.bank-transfer-request',
        id
      );
      if (!request) return;

      // Schema uses a scalar `userId` field (not a relation) — read it
      // directly from the entity.
      const targetUserId = request.userId || null;
      if (!targetUserId) return;

      const payload = {
        type: 'bank_transfer:status_changed',
        requestId: request.id,
        status: request.status,
        previousStatus: previousStatus || null,
        amount: request.amount != null ? Number(request.amount) : null,
        referenceNumber: request.referenceNumber || null,
        occurredAt: new Date().toISOString(),
        meta: meta || {},
        seq: await seq.next(targetUserId),
      };

      strapi.io.emitToUser(targetUserId, 'bank_transfer:status_changed', payload);

      // Fan out to panel20 — admins triage offline deposits from a
      // shared queue. userId surfaces in the payload for per-user
      // routing in the admin UI.
      if (typeof strapi.io.emitToAdmins === 'function') {
        strapi.io.emitToAdmins('admin:bank_transfer_event', {
          ...payload,
          userId: targetUserId,
        });
      }
    } catch (err) {
      strapi.log?.warn?.(`[BankTransfer] emitBankTransferStatusChanged failed (non-fatal): ${err.message}`);
    }
  },
}));
