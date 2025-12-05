'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::transaction.transaction', ({ strapi }) => ({
  
  /**
   * Handle PayPal webhook events
   * POST /api/transactions/paypal-webhook
   */
  async handleWebhook(ctx) {
    try {
      const headers = ctx.request.headers;
      const body = ctx.request.body;
      
      console.log('[PAYPAL WEBHOOK] Received webhook:', {
        eventType: body.event_type,
        eventId: body.id,
        resourceType: body.resource_type,
        timestamp: body.create_time
      });

      // Verify webhook signature (temporarily disabled for testing)
      const webhookId = process.env.PAYPAL_WEBHOOK_ID;
      if (!webhookId) {
        console.warn('[PAYPAL WEBHOOK] PAYPAL_WEBHOOK_ID not configured - skipping verification (NOT RECOMMENDED FOR PRODUCTION)');
      } else {
        try {
          const verification = await strapi.service('api::transaction.payment').verifyPayPalWebhook(
            headers, 
            JSON.stringify(body), 
            webhookId
          );

          if (!verification.verified) {
            console.error('[PAYPAL WEBHOOK] Webhook verification failed:', verification.error);
            // For now, continue processing but log the error
            console.warn('[PAYPAL WEBHOOK] Continuing without verification (NOT RECOMMENDED FOR PRODUCTION)');
          }
        } catch (error) {
          console.error('[PAYPAL WEBHOOK] Verification error:', error);
          console.warn('[PAYPAL WEBHOOK] Continuing without verification (NOT RECOMMENDED FOR PRODUCTION)');
        }
      }

      // Handle different event types
      switch (body.event_type) {
        case 'CHECKOUT.ORDER.APPROVED':
          await this.handleOrderApproved(body);
          break;
        case 'PAYMENT.CAPTURE.COMPLETED':
          await this.handlePaymentCompleted(body);
          break;
        case 'PAYMENT.CAPTURE.DENIED':
          await this.handlePaymentDenied(body);
          break;
        case 'PAYMENT.CAPTURE.REFUNDED':
          await this.handlePaymentRefunded(body);
          break;
        case 'PAYOUTS.PAYOUT.COMPLETED':
          await this.handlePayoutCompleted(body);
          break;
        case 'PAYOUTS.PAYOUT.FAILED':
          await this.handlePayoutFailed(body);
          break;
        default:
          console.log(`[PAYPAL WEBHOOK] Unhandled event type: ${body.event_type}`);
      }

      return ctx.send({ success: true });
    } catch (error) {
      console.error('[PAYPAL WEBHOOK] Error processing webhook:', error);
      return ctx.internalServerError('Webhook processing failed');
    }
  },

  /**
   * Handle order approved event
   */
  async handleOrderApproved(eventData) {
    try {
      const orderId = eventData.resource.id;
      console.log(`[PAYPAL WEBHOOK] Order approved: ${orderId}`);
      
      // Just capture the payment - don't process wallet update here
      // The PAYMENT.CAPTURE.COMPLETED event will handle the wallet update
      const captureResult = await strapi.service('api::transaction.payment').capturePayPalPayment(orderId);
      
      if (captureResult.success) {
        console.log(`[PAYPAL WEBHOOK] Payment captured successfully for order ${orderId} - waiting for PAYMENT.CAPTURE.COMPLETED event`);
      } else {
        console.error(`[PAYPAL WEBHOOK] Failed to capture payment for order ${orderId}:`, captureResult.error);
      }
    } catch (error) {
      console.error('[PAYPAL WEBHOOK] Error handling order approved:', error);
    }
  },

  /**
   * Handle payment completed event
   */
  async handlePaymentCompleted(eventData) {
    try {
      const capture = eventData.resource;
      const orderId = capture.supplementary_data?.related_ids?.order_id;
      
      console.log(`[PAYPAL WEBHOOK] Payment completed - Capture ID: ${capture.id}, Order ID: ${orderId}`);

      if (!orderId) {
        console.error('[PAYPAL WEBHOOK] No order ID found in capture data');
        return;
      }

      // Get order details to find wallet and user info
      const orderDetails = await strapi.service('api::transaction.payment').getPayPalOrderDetails(orderId);
      
      if (!orderDetails.success) {
        console.error('[PAYPAL WEBHOOK] Failed to get order details for:', orderId);
        return;
      }

      const order = orderDetails.order;
      const purchaseUnit = order.purchase_units[0];
      const amount = parseFloat(purchaseUnit.amount.value);
      const currency = purchaseUnit.amount.currency_code;
      
      // Extract metadata from order
      const customId = purchaseUnit.custom_id;
      let walletId = null;
      let baseAmount = null;
      
      // Try to parse custom_id as JSON (new format with baseAmount)
      try {
        if (customId) {
          const customData = JSON.parse(customId);
          walletId = customData.walletId ? parseInt(customData.walletId) : null;
          baseAmount = customData.baseAmount ? parseFloat(customData.baseAmount) : null;
        }
      } catch (e) {
        // Fallback: custom_id might be just walletId (old format)
        walletId = customId ? parseInt(customId) : null;
      }

      if (!walletId) {
        console.error('[PAYPAL WEBHOOK] No wallet ID found in order metadata');
        return;
      }
      
      // Use baseAmount if available, otherwise use full PayPal amount (for backward compatibility)
      const amountToCredit = baseAmount !== null ? baseAmount : amount;
      
      console.log(`[PAYPAL WEBHOOK] Amount to credit: ${amountToCredit} (baseAmount: ${baseAmount}, PayPal amount: ${amount})`);

      // Find the wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId }
      });

      if (!wallet) {
        console.error(`[PAYPAL WEBHOOK] Wallet not found: ${walletId}`);
        return;
      }

      // Check if transaction already exists (check both capture ID and order ID)
      const existingTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          $or: [
            { gatewayTransactionId: capture.id },
            { gatewayTransactionId: orderId }
          ],
          user_wallet: walletId
        }
      });

      if (existingTransaction) {
        console.log(`[PAYPAL WEBHOOK] Transaction already exists for capture: ${capture.id}`);
        return;
      }

      // Update wallet balance using the same logic as other payment methods
      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      const newMainBalance = currentMainBalance + amountToCredit;
      const newTotalBalance = newMainBalance + currentPromoBalance;

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: walletId },
        data: { 
          mainBalance: newMainBalance,
          balance: newTotalBalance
        }
      });

      console.log(`[PAYPAL WEBHOOK] 💵 Updated wallet balance: Main=${currentMainBalance} + ${amountToCredit} = ${newMainBalance}, Total=${newTotalBalance}`);

      // Create transaction record
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amountToCredit, // Use baseAmount (amount to credit to wallet)
          netAmount: amountToCredit, // Use baseAmount (amount to credit to wallet)
          transactionStatus: 'success',
          gateway: 'paypal',
          gatewayTransactionId: capture.id,
          description: `PayPal payment - Order ${orderId}`,
          user_wallet: walletId,
          users_permissions_user: wallet.users_permissions_user,
          fund_source: 'main_fund', // Direct payments go to main balance
          fee: 0,
          metadata: {
            orderId: orderId,
            captureId: capture.id,
            payerEmail: order.payer?.email_address,
            payerId: order.payer?.payer_id,
            currency: currency
          },
          publishedAt: new Date(),
          createdBy: null,
          updatedBy: null
        }
      });

      console.log(`[PAYPAL WEBHOOK] ✅ Payment processed successfully - Wallet ${walletId} updated with $${amountToCredit} (PayPal charged $${amount})`);

    } catch (error) {
      console.error('[PAYPAL WEBHOOK] Error handling payment completed:', error);
    }
  },

  /**
   * Handle payment denied event
   */
  async handlePaymentDenied(eventData) {
    try {
      const capture = eventData.resource;
      console.log(`[PAYPAL WEBHOOK] Payment denied - Capture ID: ${capture.id}`);
      
      // Log the denial reason
      console.log(`[PAYPAL WEBHOOK] Denial reason: ${capture.reason_code || 'Unknown'}`);
      
      // You can create a failed transaction record here if needed
    } catch (error) {
      console.error('[PAYPAL WEBHOOK] Error handling payment denied:', error);
    }
  },

  /**
   * Handle payment refunded event
   */
  async handlePaymentRefunded(eventData) {
    try {
      const refund = eventData.resource;
      console.log(`[PAYPAL WEBHOOK] Payment refunded - Refund ID: ${refund.id}`);
      
      // Find the original transaction
      const originalTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          gatewayTransactionId: refund.supplementary_data?.related_ids?.capture_id
        }
      });

      if (originalTransaction) {
        // Create refund transaction
        await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'refund',
            amount: parseFloat(refund.amount.value),
            netAmount: parseFloat(refund.amount.value),
            transactionStatus: 'success',
            gateway: 'paypal',
            gatewayTransactionId: refund.id,
            description: `PayPal refund - ${refund.note_to_payer || 'Refund processed'}`,
            user_wallet: originalTransaction.user_wallet,
            users_permissions_user: originalTransaction.users_permissions_user,
            fee: 0,
            metadata: {
              originalCaptureId: refund.supplementary_data?.related_ids?.capture_id,
              refundId: refund.id,
              reason: refund.note_to_payer
            },
            publishedAt: new Date(),
            createdBy: null,
            updatedBy: null
          }
        });

        // Update wallet balance (subtract refunded amount)
        const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: originalTransaction.user_wallet }
        });

        if (wallet) {
          const currentBalance = parseFloat(wallet.balance) || 0;
          const refundAmount = parseFloat(refund.amount.value);
          const newBalance = Math.max(0, currentBalance - refundAmount);

          await strapi.db.query('api::user-wallet.user-wallet').update({
            where: { id: wallet.id },
            data: { balance: newBalance }
          });

          console.log(`[PAYPAL WEBHOOK] ✅ Refund processed - Wallet ${wallet.id} updated with -$${refundAmount}`);
        }
      }
    } catch (error) {
      console.error('[PAYPAL WEBHOOK] Error handling payment refunded:', error);
    }
  },

  /**
   * Handle payout completed event
   */
  async handlePayoutCompleted(eventData) {
    try {
      const payout = eventData.resource;
      console.log(`[PAYPAL WEBHOOK] Payout completed - Batch ID: ${payout.batch_header.payout_batch_id}`);
      
      // Update withdrawal request status
      // You'll need to implement this based on your withdrawal system
      console.log(`[PAYPAL WEBHOOK] Payout completed for batch: ${payout.batch_header.payout_batch_id}`);
    } catch (error) {
      console.error('[PAYPAL WEBHOOK] Error handling payout completed:', error);
    }
  },

  /**
   * Handle payout failed event
   */
  async handlePayoutFailed(eventData) {
    try {
      const payout = eventData.resource;
      console.log(`[PAYPAL WEBHOOK] Payout failed - Batch ID: ${payout.batch_header.payout_batch_id}`);
      
      // Update withdrawal request status to failed
      // You'll need to implement this based on your withdrawal system
      console.log(`[PAYPAL WEBHOOK] Payout failed for batch: ${payout.batch_header.payout_batch_id}`);
    } catch (error) {
      console.error('[PAYPAL WEBHOOK] Error handling payout failed:', error);
    }
  }
}));
