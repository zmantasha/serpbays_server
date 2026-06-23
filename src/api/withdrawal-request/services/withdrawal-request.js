'use strict';

/**
 * withdrawal-request service
 */

const { createCoreService } = require('@strapi/strapi').factories;

// Per-user monotonic seq for withdrawal:status_changed pushes. Mirrors the
// wallet/order emit pattern so the client can drop out-of-order events.
const withdrawalSeqByUser = new Map();
const nextWithdrawalSeq = (userId) => {
  const k = Number.parseInt(userId, 10);
  const cur = (withdrawalSeqByUser.get(k) || 0) + 1;
  withdrawalSeqByUser.set(k, cur);
  return cur;
};

module.exports = createCoreService('api::withdrawal-request.withdrawal-request', ({ strapi }) => ({
  /**
   * Real-time push: emit `withdrawal:status_changed` on the requester's
   * channel so the publisher's My Withdrawals + Earnings pages re-render
   * without polling. Best-effort.
   *
   * Called from the content-type afterUpdate lifecycle on every real status
   * transition (pending → approved | denied; approved → paid | denied). The
   * wallet emit fires separately via `api::user-wallet.user-wallet
   * .emitBalanceUpdate` for the same transition.
   */
  async emitWithdrawalStatusChanged(requestOrId, previousStatus, meta = {}) {
    try {
      if (!strapi.io || typeof strapi.io.emitToUser !== 'function') return;

      const id = typeof requestOrId === 'object' ? requestOrId.id : requestOrId;
      if (!id) return;

      const request = await strapi.entityService.findOne(
        'api::withdrawal-request.withdrawal-request',
        id,
        { populate: ['publisher'] }
      );
      if (!request) return;

      const publisherId = request.publisher?.id || null;
      if (!publisherId) return;

      const payload = {
        type: 'withdrawal:status_changed',
        requestId: request.id,
        status: request.withdrawal_status,
        previousStatus: previousStatus || null,
        amount: request.amount != null ? Number(request.amount) : null,
        method: request.method || null,
        occurredAt: new Date().toISOString(),
        meta: meta || {},
        seq: nextWithdrawalSeq(publisherId),
      };

      strapi.io.emitToUser(publisherId, 'withdrawal:status_changed', payload);
    } catch (err) {
      strapi.log?.warn?.(`[Withdrawal] emitWithdrawalStatusChanged failed (non-fatal): ${err.message}`);
    }
  },
}));
