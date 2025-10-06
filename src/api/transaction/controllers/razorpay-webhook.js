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
   * Simple payment verification - just check payment status for order ID
   * POST /api/transactions/verify-razorpay
   */
  async verifyPayment(ctx) {
    try {
      const { order_id } = ctx.request.body;

      if (!order_id) {
        return ctx.badRequest('Missing required parameter: order_id');
      }

      console.log(`[RAZORPAY VERIFY] Checking payment status for order: ${order_id}`);

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

      // If already successful, don't update (prevent double processing)
      if (transaction.transactionStatus === 'success') {
        console.log(`[RAZORPAY VERIFY] Transaction ${transaction.id} already successful - no update needed`);
        return ctx.send({ 
          verified: true, 
          message: `Transaction already processed successfully`,
          transactionStatus: 'success',
          isProcessed: true
        });
      }

      // If failed, allow retry - user might pay again
      if (transaction.transactionStatus === 'failed') {
        console.log(`[RAZORPAY VERIFY] Transaction ${transaction.id} is failed - checking if payment was retried`);
      }

      // Get all payments for this order
      try {
        const payments = await razorpay.orders.fetchPayments(order_id);
        console.log(`[RAZORPAY VERIFY] Found ${payments.items.length} payment(s) for order ${order_id}`);

        if (payments.items.length === 0) {
          // No payments - user dismissed or never attempted
          console.log(`[RAZORPAY VERIFY] No payments found - user never attempted payment`);
          
          // Only mark as failed if transaction is pending (not already failed)
          if (transaction.transactionStatus === 'pending') {
            await this.updateTransactionStatus(transaction, 'failed', '', 'Payment not attempted - user closed payment window');
          }
          
          return ctx.send({ 
            verified: true, 
            message: 'Payment not attempted',
            transactionStatus: 'failed',
            isProcessed: true
          });
        }

        // Check all payments - prioritize successful ones (for retry scenarios)
        let successfulPayment = null;
        let failedPayment = null;
        let latestPayment = payments.items[0]; // Most recent payment
        
        // Loop through all payments to find successful one
        for (const payment of payments.items) {
          console.log(`[RAZORPAY VERIFY] Payment ${payment.id} status: ${payment.status}`);
          
          if (payment.status === 'captured') {
            successfulPayment = payment;
            break; // Found successful payment, no need to check further
          } else if (payment.status === 'failed') {
            failedPayment = payment;
          }
        }

        // Prioritize successful payment (handles retry scenario)
        if (successfulPayment) {
          console.log(`[RAZORPAY VERIFY] ✅ Found successful payment ${successfulPayment.id} - updating transaction`);
          await this.updateTransactionStatus(transaction, 'success', successfulPayment.id);
          
          return ctx.send({ 
            verified: true, 
            message: 'Payment successful',
            transactionStatus: 'success',
            paymentId: successfulPayment.id,
            isProcessed: true
          });
          
        } else if (failedPayment) {
          console.log(`[RAZORPAY VERIFY] ❌ Found failed payment ${failedPayment.id} - updating transaction`);
          const errorDescription = failedPayment.error_description || 'Payment failed';
          await this.updateTransactionStatus(transaction, 'failed', failedPayment.id, errorDescription);
          
          return ctx.send({ 
            verified: true, 
            message: `Payment failed: ${errorDescription}`,
            transactionStatus: 'failed',
            paymentId: failedPayment.id,
            isProcessed: true
          });
          
        } else {
          // Other statuses (authorized, created, etc.)
          const paymentStatus = latestPayment.status;
          const paymentId = latestPayment.id;
          
          console.log(`[RAZORPAY VERIFY] Payment ${paymentId} status: ${paymentStatus}`);
          
          // Handle different payment statuses
          if (paymentStatus === 'authorized') {
            // Payment authorized but not captured - keep as pending
            console.log(`[RAZORPAY VERIFY] Payment authorized but not captured - keeping as pending`);
            
            return ctx.send({ 
              verified: true, 
              message: 'Payment authorized, awaiting capture',
              transactionStatus: 'pending',
              paymentId: paymentId,
              isProcessed: false
            });
            
          } else if (paymentStatus === 'created') {
            // Payment created but not completed
            console.log(`[RAZORPAY VERIFY] Payment created but not completed`);
            
            // If transaction is already failed, keep it failed
            // Otherwise keep as pending (user might still be completing it)
            return ctx.send({ 
              verified: true, 
              message: 'Payment initiated but not completed',
              transactionStatus: transaction.transactionStatus,
              paymentId: paymentId,
              isProcessed: false
            });
            
          } else {
            // Unknown status - keep current transaction status
            console.log(`[RAZORPAY VERIFY] Unknown payment status: ${paymentStatus} - keeping as ${transaction.transactionStatus}`);
            
            return ctx.send({ 
              verified: true, 
              message: `Payment status: ${paymentStatus}`,
              transactionStatus: transaction.transactionStatus,
              paymentId: paymentId,
              isProcessed: false
            });
          }
        }

      } catch (error) {
        console.error('[RAZORPAY VERIFY] Error fetching payments from Razorpay:', error);
        
        // If we can't fetch payments, assume failed
        await this.updateTransactionStatus(transaction, 'failed', '', 'Unable to verify payment status');
        
        return ctx.send({ 
          verified: true, 
          message: 'Payment verification failed',
          transactionStatus: 'failed',
          isProcessed: true
        });
      }

    } catch (error) {
      console.error('[RAZORPAY VERIFY] Error verifying payment:', error);
      return ctx.internalServerError('Payment verification failed');
    }
  },

  /**
   * Simple method to update transaction status
   */
  async updateTransactionStatus(transaction, status, paymentId = '', errorDescription = '') {
    try {
      const previousStatus = transaction.transactionStatus;
      console.log(`[RAZORPAY VERIFY] Updating transaction ${transaction.id} from ${previousStatus} to ${status}`);
      
      // Prepare update data
      const updateData = { 
        transactionStatus: status,
        updatedAt: new Date()
      };
      
      // Add payment ID if provided
      if (paymentId && paymentId.trim() !== '') {
        updateData.external_transaction_id = paymentId;
      }
      
      // Add error description if provided (for failed payments)
      if (errorDescription && errorDescription.trim() !== '') {
        updateData.payment_notes = errorDescription;
      }
      
      // Clear error notes if payment is now successful after retry
      if (status === 'success' && previousStatus === 'failed') {
        updateData.payment_notes = 'Payment successful after retry';
      }
      
      // Update transaction status
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: updateData
      });

      // Update wallet balance ONLY for successful payments AND only if not already successful
      if (status === 'success' && previousStatus !== 'success' && transaction.user_wallet) {
        const amount = transaction.amount;
        const currency = transaction.currency;
        await this.updateWalletBalance(transaction.user_wallet.id, amount, currency);
        console.log(`[RAZORPAY VERIFY] ✅ Updated wallet balance +${amount} ${currency} for transaction ${transaction.id}`);
      } else if (status === 'success' && previousStatus === 'success') {
        console.log(`[RAZORPAY VERIFY] ⚠️ Transaction ${transaction.id} already successful - wallet already credited`);
      }
      
      console.log(`[RAZORPAY VERIFY] ✅ Successfully updated transaction ${transaction.id} to ${status}`);
    } catch (error) {
      console.error(`[RAZORPAY VERIFY] Error updating transaction to ${status}:`, error);
      throw error;
    }
  },

  /**
   * Clean up old pending transactions
   * This should be called periodically (e.g., via cron job)
   * Marks transactions pending for > 30 minutes as failed
   */
  async cleanupPendingTransactions(ctx) {
    try {
      console.log('[RAZORPAY CLEANUP] Starting cleanup of old pending transactions');
      
      // Find all pending Razorpay transactions older than 30 minutes
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      
      const pendingTransactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: {
          transactionStatus: 'pending',
          gateway: 'razorpay',
          createdAt: {
            $lt: thirtyMinutesAgo
          }
        },
        populate: ['user_wallet']
      });
      
      console.log(`[RAZORPAY CLEANUP] Found ${pendingTransactions.length} old pending transactions`);
      
      let cleanedCount = 0;
      
      for (const transaction of pendingTransactions) {
        try {
          // Check actual payment status with Razorpay
          const payments = await razorpay.orders.fetchPayments(transaction.gatewayTransactionId);
          
          if (payments.items.length === 0) {
            // No payments - mark as failed
            await this.updateTransactionStatus(transaction, 'failed', '', 'Transaction expired - no payment attempt');
            cleanedCount++;
            console.log(`[RAZORPAY CLEANUP] Marked transaction ${transaction.id} as failed (no payments)`);
          } else {
            // Has payments - check if any are successful
            let hasSuccess = false;
            let hasFailed = false;
            
            for (const payment of payments.items) {
              if (payment.status === 'captured') {
                hasSuccess = true;
                break;
              } else if (payment.status === 'failed') {
                hasFailed = true;
              }
            }
            
            if (hasSuccess) {
              // Should have been marked as success - update now
              await this.updateTransactionStatus(transaction, 'success', payments.items[0].id);
              cleanedCount++;
              console.log(`[RAZORPAY CLEANUP] Marked transaction ${transaction.id} as success (found successful payment)`);
            } else if (hasFailed) {
              // All payments failed - mark as failed
              await this.updateTransactionStatus(transaction, 'failed', payments.items[0].id, 'Payment failed');
              cleanedCount++;
              console.log(`[RAZORPAY CLEANUP] Marked transaction ${transaction.id} as failed (all payments failed)`);
            } else {
              // Payments still in progress or authorized - leave pending for now
              console.log(`[RAZORPAY CLEANUP] Transaction ${transaction.id} still in progress - leaving as pending`);
            }
          }
        } catch (error) {
          console.error(`[RAZORPAY CLEANUP] Error processing transaction ${transaction.id}:`, error);
        }
      }
      
      console.log(`[RAZORPAY CLEANUP] Completed cleanup - ${cleanedCount} transactions updated`);
      
      return ctx.send({
        success: true,
        message: `Cleaned up ${cleanedCount} old pending transactions`,
        totalFound: pendingTransactions.length,
        totalCleaned: cleanedCount
      });
      
    } catch (error) {
      console.error('[RAZORPAY CLEANUP] Error during cleanup:', error);
      return ctx.internalServerError('Cleanup failed');
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
