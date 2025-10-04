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
        where: { id: walletId }
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
