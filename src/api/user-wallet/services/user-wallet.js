'use strict';

/**
 * user-wallet service.
 *
 * In addition to the default core service, this exports `emitBalanceUpdate(userId, reason, meta?)`:
 *
 *   - reads the user's wallet from the DB
 *   - emits a `wallet:balance_updated` event over the WebSocket room
 *     `user_<userId>` so every active socket (multi-tab / multi-device)
 *     receives a real-time update
 *   - safe to call from any wallet-mutation site; failures are logged but
 *     never thrown (the wallet write must remain the source of truth)
 *
 * Channel:   `wallet:balance_updated` (room: `user_<userId>`)
 * Payload:
 *   {
 *     type: 'wallet:balance_updated',
 *     userId, walletId,
 *     reason: 'deposit' | 'spend' | 'refund' | 'escrow_lock' | 'escrow_release' |
 *             'promo_redemption' | 'admin_adjustment' | 'bank_transfer' |
 *             'withdrawal_pending' | 'withdrawal_refund' | 'withdrawal_paid' |
 *             'order_completion' | 'order_cancellation' | 'unspecified',
 *     balance: { main, promo, escrow, total, pendingWithdrawal },
 *     occurredAt: <ISO timestamp>,
 *     meta?: { txId?, orderId?, withdrawalId?, source? },
 *     seq:  <monotonic per-user sequence number>
 *   }
 *
 * Sequence numbers are per-user-monotonic; clients use them to drop
 * out-of-order events that arrive after a fresher state.
 */

const { createCoreService } = require('@strapi/strapi').factories;

// Per-process sequence counter (Map<userId, lastSeq>). For horizontal scaling
// with multiple Strapi pods, this should be replaced with a Redis INCR call —
// see the audit's ops-follow-up section.
const seqByUser = new Map();
const nextSeq = (userId) => {
  const cur = (seqByUser.get(userId) || 0) + 1;
  seqByUser.set(userId, cur);
  return cur;
};

module.exports = createCoreService('api::user-wallet.user-wallet', ({ strapi }) => ({
  async emitBalanceUpdate(userId, reason = 'unspecified', meta = {}) {
    try {
      const uid = Number(userId);
      if (!Number.isInteger(uid) || uid <= 0) return false;
      if (!strapi.io || typeof strapi.io.emitToUser !== 'function') {
        strapi.log?.warn?.('[wallet:emit] strapi.io.emitToUser not available — skipping');
        return false;
      }

      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: uid },
      });
      if (!wallet) {
        strapi.log?.info?.(`[wallet:emit] no wallet for user=${uid} (reason=${reason}); skipping`);
        return false;
      }

      const main = parseFloat(wallet.mainBalance || 0);
      const promo = parseFloat(wallet.promoBalance || 0);
      const escrow = parseFloat(wallet.escrowBalance || 0);
      const pendingWithdrawal = parseFloat(wallet.pendingWithdrawalBalance || 0);
      const total = main + promo;

      const payload = {
        type: 'wallet:balance_updated',
        userId: uid,
        walletId: wallet.id,
        reason,
        balance: { main, promo, escrow, total, pendingWithdrawal },
        occurredAt: new Date().toISOString(),
        meta: meta || {},
        seq: nextSeq(uid),
      };

      strapi.io.emitToUser(uid, 'wallet:balance_updated', payload);
      return true;
    } catch (err) {
      strapi.log?.error?.('[wallet:emit] failed', { error: err.message, userId, reason });
      return false;
    }
  },
}));
