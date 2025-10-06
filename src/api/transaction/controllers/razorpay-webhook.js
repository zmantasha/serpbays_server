'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const crypto = require('crypto');
const Razorpay = require('razorpay');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

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
        console.log(`[RAZORPAY WEBHOOK] Transaction ${transaction.id} already processed by verify endpoint`);
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
   * Verify payment signature and update transaction status immediately
   * This endpoint verifies the signature AND updates wallet if payment is successful
   * This provides immediate feedback while webhooks serve as backup
   */
  async verifyPayment(ctx) {
    try {
      const { order_id, payment_id, razorpay_signature } = ctx.request.body;

      if (!order_id) {
        return ctx.badRequest('Missing required parameter: order_id');
      }

      console.log(`[RAZORPAY VERIFY] Verifying payment: ${payment_id || 'N/A'} for order: ${order_id}`);

      // Handle failed/dismissed payments (no payment_id or signature)
      if (!payment_id || !razorpay_signature) {
        console.log(`[RAZORPAY VERIFY] No payment_id or signature provided - checking order status directly`);
        
        // Find the transaction
        const transaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { gatewayTransactionId: order_id },
          populate: ['user_wallet']
        });

        if (!transaction) {
          console.error(`[RAZORPAY VERIFY] Transaction not found for order: ${order_id}`);
          return ctx.send({ 
            verified: true, 
            message: 'Transaction not found',
            transactionStatus: 'not_found'
          });
        }

        // If transaction is already processed, return current status
        if (transaction.transactionStatus !== 'pending') {
          console.log(`[RAZORPAY VERIFY] Transaction ${transaction.id} already processed with status: ${transaction.transactionStatus}`);
          return ctx.send({ 
            verified: true, 
            message: `Transaction already processed with status: ${transaction.transactionStatus}`,
            transactionStatus: transaction.transactionStatus,
            isProcessed: true
          });
        }

        // For failed/dismissed payments, check with Razorpay API to get actual payment status
        try {
          console.log(`[RAZORPAY VERIFY] Checking payments for order: ${order_id}`);
          
          // Get all payments associated with this order
          const payments = await razorpay.orders.fetchPayments(order_id);
          
          console.log(`[RAZORPAY VERIFY] Found ${payments.items.length} payment(s) for order ${order_id}`);
          
          if (payments.items.length === 0) {
            // No payments found - user never attempted payment (dismissed)
            console.log(`[RAZORPAY VERIFY] No payments found - user dismissed payment modal`);
            
            await this.updateTransactionToFailed(transaction, '', 'Payment dismissed by user');
            
            return ctx.send({ 
              verified: true, 
              message: 'Payment dismissed by user',
              transactionStatus: 'failed',
              paymentStatus: 'dismissed',
              isProcessed: true
            });
          }
          
          // Check each payment's status
          let hasSuccessfulPayment = false;
          let hasFailedPayment = false;
          let lastPaymentId = '';
          let lastPaymentStatus = '';
          let lastErrorDescription = '';
          
          for (const payment of payments.items) {
            console.log(`[RAZORPAY VERIFY] Payment ${payment.id} status: ${payment.status}`);
            
            lastPaymentId = payment.id;
            lastPaymentStatus = payment.status;
            
            if (payment.status === 'captured') {
              hasSuccessfulPayment = true;
              break; // Success takes priority
            } else if (payment.status === 'failed') {
              hasFailedPayment = true;
              lastErrorDescription = payment.error_description || 'Payment failed';
            }
          }
          
          // Update transaction based on payment status
          if (hasSuccessfulPayment) {
            console.log(`[RAZORPAY VERIFY] Found successful payment: ${lastPaymentId}`);
            
            await this.updateTransactionToSuccess(transaction, lastPaymentId);
            
            return ctx.send({ 
              verified: true, 
              message: 'Payment verified and processed successfully',
              transactionStatus: 'success',
              paymentStatus: lastPaymentStatus,
              paymentId: lastPaymentId,
              isProcessed: true
            });
            
          } else if (hasFailedPayment) {
            console.log(`[RAZORPAY VERIFY] Found failed payment: ${lastPaymentId} - ${lastErrorDescription}`);
            
            await this.updateTransactionToFailed(transaction, lastPaymentId, lastErrorDescription);
            
            return ctx.send({ 
              verified: true, 
              message: `Payment failed: ${lastErrorDescription}`,
              transactionStatus: 'failed',
              paymentStatus: lastPaymentStatus,
              paymentId: lastPaymentId,
              isProcessed: true
            });
            
          } else {
            // Payments exist but none are captured or failed (might be authorized, created, etc.)
            console.log(`[RAZORPAY VERIFY] Payments exist but status is: ${lastPaymentStatus} - keeping as pending`);
            
            return ctx.send({ 
              verified: true, 
              message: `Payment status: ${lastPaymentStatus}`,
              transactionStatus: 'pending',
              paymentStatus: lastPaymentStatus,
              paymentId: lastPaymentId,
              isProcessed: false
            });
          }
          
        } catch (error) {
          console.error('[RAZORPAY VERIFY] Error fetching payments from Razorpay:', error);
          
          // If we can't fetch payments, assume payment failed
          console.log(`[RAZORPAY VERIFY] Fallback: Marking transaction ${transaction.id} as failed`);
          
          await this.updateTransactionToFailed(transaction, '', 'Unable to verify payment status');
          
          return ctx.send({ 
            verified: true, 
            message: 'Payment verification failed - marked as failed',
            transactionStatus: 'failed',
            isProcessed: true
          });
        }
      }

      // Handle successful payments with signature verification
      console.log(`[RAZORPAY VERIFY] Verifying signature for successful payment: ${payment_id}`);

      // Verify the signature
      const isValid = await strapi.service('api::transaction.payment').verifyRazorpayPayment(
        order_id,
        payment_id,
        razorpay_signature
      );

      if (!isValid) {
        console.error(`[RAZORPAY VERIFY] Invalid signature for payment: ${payment_id}`);
        return ctx.badRequest('Invalid signature');
      }

      // Find the transaction - prioritize pending transactions for retries
      let transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { 
          gatewayTransactionId: order_id,
          transactionStatus: 'pending'
        },
        populate: ['user_wallet']
      });
      
      // If no pending transaction found, look for any transaction with this order ID
      if (!transaction) {
        transaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { gatewayTransactionId: order_id },
          populate: ['user_wallet']
        });
      }

      if (!transaction) {
        console.error(`[RAZORPAY VERIFY] Transaction not found for order: ${order_id}`);
        return ctx.send({ 
          verified: true, 
          message: 'Payment verified but transaction not found',
          transactionStatus: 'not_found'
        });
      }

      console.log(`[RAZORPAY VERIFY] Found transaction ${transaction.id} with status: ${transaction.transactionStatus}`);

      // If already processed, return current status
      if (transaction.transactionStatus === 'success') {
        console.log(`[RAZORPAY VERIFY] Transaction ${transaction.id} already processed`);
        return ctx.send({ 
          verified: true, 
          message: 'Payment already processed',
          transactionStatus: 'success',
          isProcessed: true
        });
      }

      // Check actual payment status with Razorpay API
      if (transaction.transactionStatus === 'pending') {
        try {
          console.log(`[RAZORPAY VERIFY] Checking payment status with Razorpay API for: ${payment_id}`);
          
          const payment = await razorpay.payments.fetch(payment_id);
          const paymentStatus = payment.status;
          
          console.log(`[RAZORPAY VERIFY] Payment ${payment_id} status: ${paymentStatus}`);
          
          // Update transaction based on actual payment status
          if (paymentStatus === 'captured') {
            await this.updateTransactionToSuccess(transaction, payment_id);
            
            return ctx.send({ 
              verified: true, 
              message: 'Payment verified and processed successfully',
              transactionStatus: 'success',
              paymentStatus: paymentStatus,
              isProcessed: true
            });
            
          } else if (paymentStatus === 'failed') {
            await this.updateTransactionToFailed(transaction, payment_id);
            
            return ctx.send({ 
              verified: true, 
              message: 'Payment failed',
              transactionStatus: 'failed',
              paymentStatus: paymentStatus,
              isProcessed: true
            });
            
          } else {
            // Keep as pending for other statuses (authorized, created, etc.)
            console.log(`[RAZORPAY VERIFY] Payment status: ${paymentStatus} - keeping transaction as pending`);
            
            return ctx.send({ 
              verified: true, 
              message: `Payment status: ${paymentStatus}`,
              transactionStatus: 'pending',
              paymentStatus: paymentStatus,
              isProcessed: false
            });
          }
          
        } catch (error) {
          console.error('[RAZORPAY VERIFY] Error fetching payment status from Razorpay:', error);
          
          // Fallback: Update to success based on signature verification only
          console.log(`[RAZORPAY VERIFY] Fallback: Updating transaction ${transaction.id} to success based on signature verification`);
          
          await this.updateTransactionToSuccess(transaction, payment_id);
          
          return ctx.send({ 
            verified: true, 
            message: 'Payment verified and processed (fallback mode)',
            transactionStatus: 'success',
            isProcessed: true
          });
        }
      }

      // Return current status if not pending
      return ctx.send({ 
        verified: true, 
        message: 'Payment verified successfully',
        transactionStatus: transaction.transactionStatus,
        isProcessed: transaction.transactionStatus === 'success'
      });

    } catch (error) {
      console.error('[RAZORPAY VERIFY] Error verifying payment:', error);
      return ctx.internalServerError('Payment verification failed');
    }
  },

  /**
   * Update transaction to success status
   */
  async updateTransactionToSuccess(transaction, paymentId) {
    try {
      console.log(`[RAZORPAY VERIFY] Updating transaction ${transaction.id} to success`);
      
      // Update transaction status
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: { 
          transactionStatus: 'success',
          external_transaction_id: paymentId,
          updatedAt: new Date()
        }
      });

      // Update wallet balance
      const amount = transaction.amount;
      const currency = transaction.currency;
      await this.updateWalletBalance(transaction.user_wallet.id, amount, currency);
      
      console.log(`[RAZORPAY VERIFY] ✅ Successfully updated transaction ${transaction.id} and wallet ${transaction.user_wallet.id}`);
    } catch (error) {
      console.error('[RAZORPAY VERIFY] Error updating transaction to success:', error);
      throw error;
    }
  },

  /**
   * Update transaction to failed status
   */
  async updateTransactionToFailed(transaction, paymentId, errorDescription = '') {
    try {
      console.log(`[RAZORPAY VERIFY] Updating transaction ${transaction.id} to failed`);
      
      // Prepare update data
      const updateData = { 
        transactionStatus: 'failed',
        updatedAt: new Date()
      };
      
      // Only update external_transaction_id if paymentId is provided
      if (paymentId && paymentId.trim() !== '') {
        updateData.external_transaction_id = paymentId;
      }
      
      // Add error description if provided
      if (errorDescription && errorDescription.trim() !== '') {
        updateData.payment_notes = `Payment failed: ${errorDescription}`;
      }
      
      // Update transaction status
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: updateData
      });
      
      console.log(`[RAZORPAY VERIFY] ❌ Successfully updated transaction ${transaction.id} to failed`);
    } catch (error) {
      console.error('[RAZORPAY VERIFY] Error updating transaction to failed:', error);
      throw error;
    }
  },

  /**
   * Manually update transaction status (for admin use)
   * POST /api/transactions/manual-update-razorpay
   */
  async manualUpdate(ctx) {
    try {
      const { order_id, payment_id, status } = ctx.request.body;

      if (!order_id || !status) {
        return ctx.badRequest('Missing required parameters: order_id, status');
      }

      console.log(`[RAZORPAY MANUAL] Manual update for order: ${order_id}, status: ${status}`);

      // Find the transaction
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: order_id },
        populate: ['user_wallet']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      // Update transaction status
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: { 
          transactionStatus: status,
          external_transaction_id: payment_id || transaction.external_transaction_id,
          updatedAt: new Date()
        }
      });

      // Update wallet balance if status is success
      if (status === 'success' && transaction.user_wallet) {
        const amount = transaction.amount;
        const currency = transaction.currency;
        await this.updateWalletBalance(transaction.user_wallet.id, amount, currency);
        
        console.log(`[RAZORPAY MANUAL] ✅ Updated transaction ${transaction.id} and wallet ${transaction.user_wallet.id}`);
      }

      return ctx.send({ 
        success: true,
        message: `Transaction ${transaction.id} updated to ${status}`,
        transactionId: transaction.id,
        status: status
      });

    } catch (error) {
      console.error('[RAZORPAY MANUAL] Error:', error);
      return ctx.internalServerError('Manual update failed');
    }
  }
}));
