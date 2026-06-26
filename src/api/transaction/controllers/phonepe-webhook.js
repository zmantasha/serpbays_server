'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const phonepeService = require('../services/phonepe');

module.exports = createCoreController('api::transaction.transaction', ({ strapi }) => ({
  
  /**
   * Handle PhonePe callback
   * Similar to Razorpay webhook handling
   * POST /api/transactions/phonepe-callback
   */
  async handleCallback(ctx) {
    try {
      const { response } = ctx.request.body;
      const signature = ctx.request.headers['x-verify'];

      console.log('[PHONEPE CALLBACK] Received callback');

      if (!response || !signature) {
        console.error('[PHONEPE CALLBACK] Missing response or signature');
        return ctx.badRequest('Invalid callback data');
      }

      // Verify and parse callback
      const callbackResult = await phonepeService.handleCallback(response, signature);

      if (!callbackResult.success) {
        console.error('[PHONEPE CALLBACK] Callback verification failed:', callbackResult.error);
        return ctx.forbidden('Invalid signature');
      }

      const { transactionId, state, amount, paymentInstrument, responseCode } = callbackResult;

      console.log(`[PHONEPE CALLBACK] Transaction ${transactionId}: ${state}`);

      // Find transaction by merchant transaction ID
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: transactionId },
        populate: ['user_wallet']
      });

      if (!transaction) {
        console.error(`[PHONEPE CALLBACK] Transaction not found: ${transactionId}`);
        return ctx.send({ success: true, message: 'Transaction not found' });
      }

      // Check if already processed
      if (transaction.transactionStatus === 'success') {
        console.log(`[PHONEPE CALLBACK] Transaction ${transaction.id} already processed`);
        return ctx.send({ success: true, message: 'Already processed' });
      }

      // Map PhonePe states to our transaction status
      let transactionStatus = 'pending';
      if (state === 'COMPLETED') {
        transactionStatus = 'success';
      } else if (state === 'FAILED') {
        transactionStatus = 'failed';
      }

      // ─────────────────────────────────────────────────────────────────
      // Audit Wave-3 Vector C — M11 amount-mismatch cross-check.
      // Compare PhonePe-reported amount to the server-computed
      // expectedChargeCents stashed at create time. Refuse credit on
      // mismatch (and demote the tx to failed). This guards against
      // PhonePe-side adjustments, partial captures, or replay against a
      // pending row with a different expected amount. Grace-period
      // boundary matches the other gateway webhooks (2026-07-16).
      // ─────────────────────────────────────────────────────────────────
      if (state === 'COMPLETED') {
        const expectedChargeCents = transaction.metadata?.expectedChargeCents;
        const actualChargeCents = Math.round((Number(amount) || 0) * 100);
        const GRACE_PERIOD_END = new Date('2026-07-16T00:00:00Z');
        if (Number.isFinite(Number(expectedChargeCents)) && Number(expectedChargeCents) > 0) {
          if (actualChargeCents !== Number(expectedChargeCents)) {
            strapi.log.error(
              `[PHONEPE CALLBACK] amount mismatch — REFUSING wallet credit. ` +
              `actual=${actualChargeCents} expected=${expectedChargeCents} ` +
              `tx=${transaction.id} transactionId=${transactionId}`
            );
            await strapi.entityService.update('api::transaction.transaction', transaction.id, {
              data: {
                transactionStatus: 'failed',
                payment_notes: `PhonePe amount mismatch: expected=${expectedChargeCents}c actual=${actualChargeCents}c`,
                metadata: {
                  ...(transaction.metadata || {}),
                  m11Error: 'amount_mismatch',
                  actualChargeCents,
                  expectedChargeCents: Number(expectedChargeCents),
                  refusedAt: new Date().toISOString(),
                },
                updatedAt: new Date(),
              },
            });
            return ctx.send({ success: true, refused: true, reason: 'amount_mismatch' });
          }
        } else if (new Date() > GRACE_PERIOD_END) {
          strapi.log.error(
            `[PHONEPE CALLBACK] missing expectedChargeCents post-grace-period — REFUSING. tx=${transaction.id}`
          );
          await strapi.entityService.update('api::transaction.transaction', transaction.id, {
            data: { transactionStatus: 'failed', payment_notes: 'PhonePe missing expectedChargeCents post-grace' },
          });
          return ctx.send({ success: true, refused: true, reason: 'missing_expected_charge_cents' });
        } else {
          strapi.log.warn(`[PHONEPE CALLBACK] legacy tx missing expectedChargeCents (grace period). tx=${transaction.id}`);
        }
      }

      // Update transaction
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: {
          transactionStatus: transactionStatus,
          external_transaction_id: transactionId,
          payment_notes: `PhonePe: ${state} - Code: ${responseCode}`,
          updatedAt: new Date()
        }
      });

      console.log(`[PHONEPE CALLBACK] Updated transaction ${transaction.id} to ${transactionStatus}`);

      // Update wallet if payment successful
      if (state === 'COMPLETED') {
        await this.updateWalletBalance(transaction.user_wallet.id, amount, transaction.currency);
        console.log(`[PHONEPE CALLBACK] ✅ Successfully processed payment for wallet ${transaction.user_wallet.id}`);
      }

      return ctx.send({ success: true });

    } catch (error) {
      console.error('[PHONEPE CALLBACK] Error processing callback:', error);
      return ctx.internalServerError('Callback processing failed');
    }
  },

  /**
   * Check transaction status (for client polling)
   * POST /api/transactions/phonepe-status
   */
  async checkStatus(ctx) {
    try {
      const { transactionId } = ctx.request.body;

      if (!transactionId) {
        return ctx.badRequest('Transaction ID required');
      }

      console.log(`[PHONEPE STATUS] Checking status for ${transactionId}`);

      // Check status with PhonePe
      const statusResult = await phonepeService.checkTransactionStatus(transactionId);

      if (!statusResult.success) {
        return ctx.badRequest('Status check failed');
      }

      // Find our transaction
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: transactionId },
        populate: ['user_wallet']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      // Update transaction if needed
      let transactionStatus = transaction.transactionStatus;

      if (statusResult.state === 'COMPLETED' && transactionStatus !== 'success') {
        // ─────────────────────────────────────────────────────────────
        // Audit Wave-3 Vector C — same M11 amount-mismatch check as the
        // callback path. checkStatus is also a wallet-credit primitive
        // (auth:false, body-supplied transactionId — see follow-up T12)
        // so it must apply the same defense.
        // ─────────────────────────────────────────────────────────────
        {
          const expectedChargeCents = transaction.metadata?.expectedChargeCents;
          const actualChargeCents = Math.round((Number(statusResult.amount) || 0) * 100);
          const GRACE_PERIOD_END = new Date('2026-07-16T00:00:00Z');
          if (Number.isFinite(Number(expectedChargeCents)) && Number(expectedChargeCents) > 0) {
            if (actualChargeCents !== Number(expectedChargeCents)) {
              strapi.log.error(
                `[PHONEPE STATUS] amount mismatch — REFUSING wallet credit. ` +
                `actual=${actualChargeCents} expected=${expectedChargeCents} ` +
                `tx=${transaction.id} transactionId=${transactionId}`
              );
              await strapi.entityService.update('api::transaction.transaction', transaction.id, {
                data: {
                  transactionStatus: 'failed',
                  payment_notes: `PhonePe amount mismatch: expected=${expectedChargeCents}c actual=${actualChargeCents}c`,
                  metadata: {
                    ...(transaction.metadata || {}),
                    m11Error: 'amount_mismatch',
                    actualChargeCents,
                    expectedChargeCents: Number(expectedChargeCents),
                    refusedAt: new Date().toISOString(),
                  },
                  updatedAt: new Date(),
                },
              });
              return ctx.send({ success: true, refused: true, reason: 'amount_mismatch' });
            }
          } else if (new Date() > GRACE_PERIOD_END) {
            strapi.log.error(
              `[PHONEPE STATUS] missing expectedChargeCents post-grace-period — REFUSING. tx=${transaction.id}`
            );
            await strapi.entityService.update('api::transaction.transaction', transaction.id, {
              data: { transactionStatus: 'failed', payment_notes: 'PhonePe missing expectedChargeCents post-grace' },
            });
            return ctx.send({ success: true, refused: true, reason: 'missing_expected_charge_cents' });
          } else {
            strapi.log.warn(`[PHONEPE STATUS] legacy tx missing expectedChargeCents (grace period). tx=${transaction.id}`);
          }
        }

        // Update to success
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: 'success',
            external_transaction_id: transactionId,
            updatedAt: new Date()
          }
        });

        // Update wallet
        await this.updateWalletBalance(transaction.user_wallet.id, statusResult.amount, transaction.currency);

        transactionStatus = 'success';
        console.log(`[PHONEPE STATUS] ✅ Updated transaction ${transaction.id} to success`);
      } else if (statusResult.state === 'FAILED' && transactionStatus !== 'failed') {
        // Update to failed
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: 'failed',
            external_transaction_id: transactionId,
            updatedAt: new Date()
          }
        });
        
        transactionStatus = 'failed';
        console.log(`[PHONEPE STATUS] ❌ Updated transaction ${transaction.id} to failed`);
      }

      return ctx.send({
        success: true,
        transactionStatus: transactionStatus,
        phonepeState: statusResult.state,
        isProcessed: transactionStatus === 'success'
      });

    } catch (error) {
      console.error('[PHONEPE STATUS] Error checking status:', error);
      return ctx.internalServerError('Status check failed');
    }
  },

  /**
   * Update wallet balance after successful payment
   */
  async updateWalletBalance(walletId, amount, currency) {
    try {
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId },
        populate: ['users_permissions_user'],
      });

      if (!wallet) {
        throw new Error(`Wallet not found: ${walletId}`);
      }

      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      const newMainBalance = currentMainBalance + amount;
      const newTotalBalance = newMainBalance + currentPromoBalance;

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: walletId },
        data: {
          mainBalance: newMainBalance,
          balance: newTotalBalance,
          updatedAt: new Date()
        }
      });

      console.log(`[PHONEPE WALLET] 💵 Wallet updated: Main=${currentMainBalance} + ${amount} = ${newMainBalance}`);

      // Real-time push so the wallet UI sees the deposit instantly.
      try {
        const targetUserId = wallet.users_permissions_user?.id;
        if (targetUserId) {
          await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
            targetUserId,
            'phonepe_deposit',
            { walletId, amount, currency }
          );
        }
      } catch (emitErr) {
        console.warn('[PHONEPE WALLET] emitBalanceUpdate failed (non-fatal):', emitErr.message);
      }

    } catch (error) {
      console.error('[PHONEPE WALLET] Error updating wallet:', error);
      throw error;
    }
  },

  /**
   * Handle redirect after payment
   * This is called when user is redirected back from PhonePe
   */
  async handleRedirect(ctx) {
    try {
      // PhonePe sends data as POST to redirect URL
      const { merchantId, transactionId, amount, code } = ctx.request.body;

      console.log(`[PHONEPE REDIRECT] User returned from PhonePe: ${transactionId}`);

      // Verify transaction status
      const statusResult = await phonepeService.checkTransactionStatus(transactionId);

      if (statusResult.success) {
        // Redirect to wallet page with status
        const redirectUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/wallet?phonepe_status=success&transaction_id=${transactionId}`;
        return ctx.redirect(redirectUrl);
      } else {
        const redirectUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/wallet?phonepe_status=failed&transaction_id=${transactionId}`;
        return ctx.redirect(redirectUrl);
      }

    } catch (error) {
      console.error('[PHONEPE REDIRECT] Error handling redirect:', error);
      const redirectUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/wallet?phonepe_status=error`;
      return ctx.redirect(redirectUrl);
    }
  }
}));
