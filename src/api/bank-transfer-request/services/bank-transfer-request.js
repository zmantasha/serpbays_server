'use strict';

/**
 * bank-transfer-request service
 */

const { createCoreService } = require('@strapi/strapi').factories;

// Per-user monotonic seq for bank_transfer:status_changed pushes.
const btrSeqByUser = new Map();
const nextBtrSeq = (userId) => {
  const k = Number.parseInt(userId, 10);
  const cur = (btrSeqByUser.get(k) || 0) + 1;
  btrSeqByUser.set(k, cur);
  return cur;
};

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
        seq: nextBtrSeq(targetUserId),
      };

      strapi.io.emitToUser(targetUserId, 'bank_transfer:status_changed', payload);
    } catch (err) {
      strapi.log?.warn?.(`[BankTransfer] emitBankTransferStatusChanged failed (non-fatal): ${err.message}`);
    }
  },
}));
