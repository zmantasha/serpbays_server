'use strict';

/**
 * Bank-transfer-request lifecycle — real-time push.
 *
 * Mirrors the order/withdrawal pattern: afterCreate covers the initial
 * pending state (so any other open tab for the user sees the request
 * appear), and afterUpdate fires on status transitions
 * (pending/processing/completed/rejected).
 *
 * The wallet credit emit for the `completed` transition fires from the
 * controller (post-commit, gated on `walletCredited`) — see pass 2 of
 * the realtime audit.
 */
module.exports = {
  async afterCreate(event) {
    try {
      const { result } = event;
      if (!result?.id) return;
      await strapi.service('api::bank-transfer-request.bank-transfer-request')
        .emitBankTransferStatusChanged(result, null, { lifecycle: 'afterCreate' });
    } catch (err) {
      strapi.log?.warn?.(`[BankTransfer lifecycle] afterCreate emit failed (non-fatal): ${err.message}`);
    }
  },

  async afterUpdate(event) {
    try {
      const { result, params } = event;
      if (!result?.id) return;
      // Emit only when the update changed the status field — other
      // mutations (adminNotes-only edits, idempotent no-ops) shouldn't
      // spam the channel.
      const dataHadStatus = params?.data && Object.prototype.hasOwnProperty.call(params.data, 'status');
      if (!dataHadStatus) return;
      await strapi.service('api::bank-transfer-request.bank-transfer-request')
        .emitBankTransferStatusChanged(result, null, { lifecycle: 'afterUpdate' });
    } catch (err) {
      strapi.log?.warn?.(`[BankTransfer lifecycle] afterUpdate emit failed (non-fatal): ${err.message}`);
    }
  },
};
