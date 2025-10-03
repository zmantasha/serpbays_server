'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const crypto = require('crypto');

module.exports = createCoreController('api::transaction.transaction', ({ strapi }) => ({
  
  /**
   * Handle Razorpay webhook events
   * POST /api/transactions/razorpay-webhook
   */
  async handleWebhook(ctx) {
    try {
      const body = ctx.request.body;
      const headers = ctx.request.headers;
      
      console.log('[RAZORPAY WEBHOOK] Received webhook:', {
        event: body.event,
        orderId: body.payload?.payment?.entity?.order_id,
        paymentId: body.payload?.payment?.entity?.id,
        timestamp: new Date().toISOString()
      });

      // Verify webhook signature
      const razorpaySignature = headers['x-razorpay-signature'];
      if (!razorpaySignature) {
        console.error('[RAZORPAY WEBHOOK] Missing signature header');
        return ctx.badRequest('Missing signature header');
      }

      // Verify webhook signature
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.warn('[RAZORPAY WEBHOOK] RAZORPAY_WEBHOOK_SECRET not configured - skipping verification (NOT RECOMMENDED FOR PRODUCTION)');
      } else {
        const expectedSignature = crypto
          .createHmac('sha256', webhookSecret)
          .update(JSON.stringify(body))
          .digest('hex');

        if (razorpaySignature !== expectedSignature) {
          console.error('[RAZORPAY WEBHOOK] Invalid signature');
          return ctx.forbidden('Invalid signature');
        }
      }

      // Handle different event types
      switch (body.event) {
        case 'payment.captured':
          await this.handlePaymentCaptured(body);
          break;
        case 'payment.failed':
          await this.handlePaymentFailed(body);
          break;
        case 'order.paid':
          await this.handleOrderPaid(body);
          break;
        default:
          console.log(`[RAZORPAY WEBHOOK] Unhandled event type: ${body.event}`);
      }

      return ctx.send({ success: true });
    } catch (error) {
      console.error('[RAZORPAY WEBHOOK] Error processing webhook:', error);
      return ctx.internalServerError('Webhook processing failed');
    }
  },

  /**
   * Handle payment captured event
   */
  async handlePaymentCaptured(eventData) {
    try {
      const payment = eventData.payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;
      const amount = payment.amount / 100; // Convert from paise to currency unit
      const currency = payment.currency;
      const status = payment.status;

      console.log(`[RAZORPAY WEBHOOK] Payment captured: ${paymentId} for order ${orderId}, amount: ${amount} ${currency}`);

      // Find the transaction by order ID
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: orderId },
        populate: ['user_wallet']
      });

      if (!transaction) {
        console.error(`[RAZORPAY WEBHOOK] Transaction not found for order ID: ${orderId}`);
        return;
      }

      // Check if already processed
      if (transaction.transactionStatus === 'success') {
        console.log(`[RAZORPAY WEBHOOK] Transaction ${transaction.id} already processed`);
        return;
      }

      // Update transaction status
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: { 
          transactionStatus: status === 'captured' ? 'success' : 'failed',
          external_transaction_id: paymentId,
          updatedAt: new Date()
        }
      });

      if (status === 'captured') {
        // Update wallet balance
        await this.updateWalletBalance(transaction.user_wallet.id, amount, currency);
        
        console.log(`[RAZORPAY WEBHOOK] ✅ Successfully processed payment ${paymentId} for wallet ${transaction.user_wallet.id}`);
      }

    } catch (error) {
      console.error('[RAZORPAY WEBHOOK] Error in handlePaymentCaptured:', error);
      throw error;
    }
  },

  /**
   * Handle payment failed event
   */
  async handlePaymentFailed(eventData) {
    try {
      const payment = eventData.payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;
      const errorDescription = payment.error_description || 'Payment failed';

      console.log(`[RAZORPAY WEBHOOK] Payment failed: ${paymentId} for order ${orderId}, reason: ${errorDescription}`);

      // Find and update transaction
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: orderId }
      });

      if (transaction) {
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: { 
            transactionStatus: 'failed',
            external_transaction_id: paymentId,
            payment_notes: `Payment failed: ${errorDescription}`,
            updatedAt: new Date()
          }
        });

        console.log(`[RAZORPAY WEBHOOK] ❌ Marked transaction ${transaction.id} as failed`);
      }

    } catch (error) {
      console.error('[RAZORPAY WEBHOOK] Error in handlePaymentFailed:', error);
      throw error;
    }
  },

  /**
   * Handle order paid event
   */
  async handleOrderPaid(eventData) {
    try {
      const order = eventData.payload.order.entity;
      const orderId = order.id;
      const amount = order.amount / 100;
      const currency = order.currency;
      const status = order.status;

      console.log(`[RAZORPAY WEBHOOK] Order paid: ${orderId}, amount: ${amount} ${currency}, status: ${status}`);

      // Find the transaction
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: orderId },
        populate: ['user_wallet']
      });

      if (!transaction) {
        console.error(`[RAZORPAY WEBHOOK] Transaction not found for order ID: ${orderId}`);
        return;
      }

      // Update transaction status
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: { 
          transactionStatus: status === 'paid' ? 'success' : 'failed',
          updatedAt: new Date()
        }
      });

      if (status === 'paid') {
        // Update wallet balance
        await this.updateWalletBalance(transaction.user_wallet.id, amount, currency);
        
        console.log(`[RAZORPAY WEBHOOK] ✅ Successfully processed order ${orderId} for wallet ${transaction.user_wallet.id}`);
      }

    } catch (error) {
      console.error('[RAZORPAY WEBHOOK] Error in handleOrderPaid:', error);
      throw error;
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

      // Update wallet balance
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

      console.log(`[RAZORPAY WEBHOOK] 💵 Wallet updated: Main=${currentMainBalance} + ${amount} = ${newMainBalance}`);

    } catch (error) {
      console.error('[RAZORPAY WEBHOOK] Error updating wallet balance:', error);
      throw error;
    }
  },

  /**
   * Verify payment signature manually (for client-side verification)
   * This endpoint ONLY verifies the signature - does NOT update wallet
   * Wallet updates are handled by webhooks for reliability
   */
  async verifyPayment(ctx) {
    try {
      const { order_id, payment_id, razorpay_signature } = ctx.request.body;

      if (!order_id || !payment_id || !razorpay_signature) {
        return ctx.badRequest('Missing required parameters');
      }

      // Only verify the signature - don't update wallet here
      const isValid = await strapi.service('api::transaction.payment').verifyRazorpayPayment(
        order_id,
        payment_id,
        razorpay_signature
      );

      if (isValid) {
        // Check if transaction exists and its current status
        const transaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { gatewayTransactionId: order_id },
          populate: ['user_wallet']
        });

        if (transaction) {
          // Return verification status and transaction info
          return ctx.send({ 
            verified: true, 
            message: 'Payment verified successfully',
            transactionStatus: transaction.transactionStatus,
            isProcessed: transaction.transactionStatus === 'success'
          });
        } else {
          return ctx.send({ 
            verified: true, 
            message: 'Payment verified but transaction not found',
            transactionStatus: 'not_found'
          });
        }
      } else {
        return ctx.badRequest('Invalid signature');
      }

    } catch (error) {
      console.error('Error verifying payment:', error);
      return ctx.internalServerError('Payment verification failed');
    }
  }
}));
