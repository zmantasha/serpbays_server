'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const crypto = require('crypto');

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

      // CRITICAL: Verify webhook signature - MANDATORY (no bypass)
      const webhookId = process.env.PAYPAL_WEBHOOK_ID;
      if (!webhookId) {
        console.error('[PAYPAL WEBHOOK] ❌ CRITICAL: PAYPAL_WEBHOOK_ID not configured in environment');
        return ctx.internalServerError('Webhook verification failed - missing webhook ID');
      }

      // Verify signature using PayPal SDK
      const verification = await strapi.service('api::transaction.payment').verifyPayPalWebhook(
        headers,
        body,
        webhookId
      );

      if (!verification.success || !verification.verified) {
        console.error('[PAYPAL WEBHOOK] ❌ Webhook signature verification FAILED - possible fraud attempt');
        console.error('[PAYPAL WEBHOOK] Verification details:', verification.error || verification.verificationStatus);
        return ctx.forbidden('Invalid webhook signature');
      }

      console.log('[PAYPAL WEBHOOK] ✅ Webhook signature verified successfully');

      // IDEMPOTENCY: Note - Duplicate check is handled in handlePaymentCompleted 
      // by checking for existing transactions with the specific capture/order ID
      // This is more reliable than searching in metadata JSON field

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
      const paypalOrderAmount = parseFloat(purchaseUnit.amount.value);
      const paypalCaptureAmount = parseFloat(capture.amount.value);
      const currency = purchaseUnit.amount.currency_code;

      // SECURITY: Verify amounts match (prevent tampering)
      if (Math.abs(paypalOrderAmount - paypalCaptureAmount) > 0.01) {
        console.error('[PAYPAL WEBHOOK] ❌ Amount mismatch detected - possible fraud!');
        console.error(`[PAYPAL WEBHOOK] Order amount: ${paypalOrderAmount}, Capture amount: ${paypalCaptureAmount}`);
        return;  // Don't credit wallet if amounts don't match
      }

      console.log(`[PAYPAL WEBHOOK] ✅ Amount verification passed: ${paypalCaptureAmount} ${currency}`);

      // Extract metadata from order
      const customId = purchaseUnit.custom_id;
      let walletId = null;
      let baseAmount = null;
      let expectedChargeCentsFromMeta = null;

      // Try to parse custom_id as JSON (new format with baseAmount + expectedChargeCents)
      try {
        if (customId) {
          const customData = JSON.parse(customId);
          walletId = customData.walletId ? parseInt(customData.walletId) : null;
          baseAmount = customData.baseAmount ? parseFloat(customData.baseAmount) : null;
          // Audit M11 — server-computed expected charge (cents). Set in
          // createPayment via computeFees. Used to cross-check the actual
          // PayPal charge below before crediting the wallet.
          expectedChargeCentsFromMeta = customData.expectedChargeCents != null ? Number(customData.expectedChargeCents) : null;
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
      const amountToCredit = baseAmount !== null ? baseAmount : paypalCaptureAmount;

      // ─────────────────────────────────────────────────────────────────
      // Audit M11 — amount-mismatch cross-check.
      // Compare PayPal's actual capture amount (cents) to the server-
      // computed expectedChargeCents stashed in PayPal order custom_id.
      // Refuse to credit on mismatch.
      // ─────────────────────────────────────────────────────────────────
      {
        const actualChargeCents = Math.round(paypalCaptureAmount * 100);
        const GRACE_PERIOD_END = new Date('2026-07-16T00:00:00Z');
        if (Number.isFinite(expectedChargeCentsFromMeta) && expectedChargeCentsFromMeta > 0) {
          if (actualChargeCents !== expectedChargeCentsFromMeta) {
            strapi.log.error(
              `[PAYPAL WEBHOOK] amount mismatch — REFUSING wallet credit. ` +
              `capture.amount=${actualChargeCents}c expected=${expectedChargeCentsFromMeta}c ` +
              `walletId=${walletId} captureId=${capture.id}`
            );
            // No DB tx exists yet (PayPal creates tx in the webhook). Create
            // a failed record so the attempt is auditable.
            await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'deposit',
                amount: 0,
                netAmount: 0,
                transactionStatus: 'failed',
                gateway: 'paypal',
                gatewayTransactionId: capture.id,
                description: `PayPal amount mismatch - Order ${orderId}`,
                user_wallet: walletId,
                fund_source: 'main_fund',
                metadata: {
                  error: 'amount_mismatch',
                  actualChargeCents,
                  expectedChargeCents: expectedChargeCentsFromMeta,
                  orderId,
                  captureId: capture.id,
                  processedAt: new Date().toISOString(),
                },
                publishedAt: new Date(),
              },
            });
            return;
          }
        } else if (new Date() > GRACE_PERIOD_END) {
          strapi.log.error(`[PAYPAL WEBHOOK] missing expectedChargeCents post-grace-period — REFUSING. orderId=${orderId}`);
          return;
        } else {
          strapi.log.warn(`[PAYPAL WEBHOOK] legacy PayPal order missing expectedChargeCents (grace period); orderId=${orderId}`);
        }
      }

      console.log(`[PAYPAL WEBHOOK] Amount to credit: ${amountToCredit} (baseAmount: ${baseAmount}, PayPal charged: ${paypalCaptureAmount})`);

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
          gatewayTransactionId: capture.id,
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
            webhookEventId: eventData.id,  // For idempotency tracking
            payerEmailHash: order.payer?.email_address
              ? crypto.createHash('sha256').update(order.payer.email_address.toLowerCase()).digest('hex')
              : null,  // Hash email for GDPR compliance
            payerId: order.payer?.payer_id,
            currency: currency
          },
          publishedAt: new Date(),
          createdBy: null,
          updatedBy: null
        }
      });

      console.log(`[PAYPAL WEBHOOK] ✅ Payment processed successfully - Wallet ${walletId} updated with $${amountToCredit} (PayPal charged $${paypalCaptureAmount})`);

      // Real-time push so the client sees the deposit instantly. Best-effort.
      try {
        const walletWithUser = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: walletId },
          populate: ['users_permissions_user'],
        });
        const targetUserId = walletWithUser?.users_permissions_user?.id;
        if (targetUserId) {
          await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
            targetUserId,
            'paypal_deposit',
            { orderId, captureId: capture.id, amount: amountToCredit, walletId }
          );
        }
      } catch (emitErr) {
        console.warn('[PAYPAL WEBHOOK] emitBalanceUpdate failed (non-fatal):', emitErr.message);
      }

    } catch (error) {
      console.error('[PAYPAL WEBHOOK] Error handling payment completed:', error);
    }
  },

  /**
   * Handle payment denied event
   * Creates a failed transaction record for audit trail and user visibility
   */
  async handlePaymentDenied(eventData) {
    try {
      const capture = eventData.resource;
      const orderId = capture.supplementary_data?.related_ids?.order_id;

      console.log(`[PAYPAL WEBHOOK] Payment denied - Capture ID: ${capture.id}, Order ID: ${orderId}`);
      console.log(`[PAYPAL WEBHOOK] Denial reason: ${capture.reason_code || 'Unknown'}`);

      if (!orderId) {
        console.error('[PAYPAL WEBHOOK] No order ID found for denied payment');
        return;
      }

      // Get order details to find wallet and user info
      const orderDetails = await strapi.service('api::transaction.payment').getPayPalOrderDetails(orderId);

      if (!orderDetails.success) {
        console.error('[PAYPAL WEBHOOK] Failed to get order details for denied payment:', orderId);
        return;
      }

      const order = orderDetails.order;
      const purchaseUnit = order.purchase_units[0];
      const amount = parseFloat(purchaseUnit.amount.value);
      const currency = purchaseUnit.amount.currency_code;

      // Extract wallet ID from custom_id
      let walletId = null;
      let baseAmount = null;

      try {
        if (purchaseUnit.custom_id) {
          const customData = JSON.parse(purchaseUnit.custom_id);
          walletId = customData.walletId ? parseInt(customData.walletId) : null;
          baseAmount = customData.baseAmount ? parseFloat(customData.baseAmount) : null;
        }
      } catch (e) {
        // Fallback: custom_id might be just walletId (old format)
        walletId = purchaseUnit.custom_id ? parseInt(purchaseUnit.custom_id) : null;
      }

      if (!walletId) {
        console.error('[PAYPAL WEBHOOK] No wallet ID found in order metadata for denied payment');
        return;
      }

      // Find the wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId }
      });

      if (!wallet) {
        console.error(`[PAYPAL WEBHOOK] Wallet not found: ${walletId}`);
        return;
      }

      // Check if failed transaction already exists
      const existingTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          gatewayTransactionId: capture.id,
          user_wallet: walletId
        }
      });

      let failedTxId;
      if (existingTransaction) {
        console.log(`[PAYPAL WEBHOOK] Transaction already exists for capture ${capture.id}, updating to failed`);

        // Update existing transaction to failed
        await strapi.entityService.update('api::transaction.transaction', existingTransaction.id, {
          data: {
            transactionStatus: 'failed',
            payment_notes: `Payment denied - Reason: ${capture.reason_code || 'Unknown'}`,
            metadata: {
              ...existingTransaction.metadata,
              denialReason: capture.reason_code,
              failureTimestamp: new Date().toISOString()
            }
          }
        });

        console.log(`[PAYPAL WEBHOOK] ✅ Updated transaction ${existingTransaction.id} to failed status`);
        failedTxId = existingTransaction.id;
      } else {
        // Use baseAmount if available, otherwise use full PayPal amount
        const failedAmount = baseAmount !== null ? baseAmount : amount;

        // Create failed transaction record
        const created = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'deposit',
            amount: failedAmount,
            netAmount: failedAmount,
            transactionStatus: 'failed',
            gateway: 'paypal',
            gatewayTransactionId: capture.id,
            description: 'PayPal payment failed',
            payment_notes: `Payment denied - Reason: ${capture.reason_code || 'Unknown'}`,
            user_wallet: walletId,
            users_permissions_user: wallet.users_permissions_user,
            fund_source: 'main_fund',
            fee: 0,
            metadata: {
              orderId: orderId,
              captureId: capture.id,
              webhookEventId: eventData.id,  // For idempotency tracking
              denialReason: capture.reason_code,
              currency: currency,
              failureTimestamp: new Date().toISOString()
              // Note: No payer email stored for failed transactions (GDPR compliance)
            },
            publishedAt: new Date(),
            createdBy: null,
            updatedBy: null
          }
        });

        console.log(`[PAYPAL WEBHOOK] ✅ Failed transaction recorded for wallet ${walletId} - Amount: $${failedAmount}, Reason: ${capture.reason_code || 'Unknown'}`);
        failedTxId = created?.id;
      }

      try {
        if (failedTxId) {
          const txWithUser = await strapi.db.query('api::transaction.transaction').findOne({
            where: { id: failedTxId },
            populate: ['users_permissions_user']
          });
          if (txWithUser?.users_permissions_user?.email) {
            await strapi.service('api::global.email-operations').sendTransactionEmail({
              transaction: txWithUser,
              userEmail: txWithUser.users_permissions_user.email,
              statusLabel: 'failed',
              statusMessage: 'Your payment could not be processed. Please try again.',
              notes: `Payment denied - Reason: ${capture.reason_code || 'Unknown'}`,
              flags: { is_payment_failed: true },
              tags: ['transaction', 'payment', 'failed', 'paypal'],
            });
          }
        }
      } catch (emailErr) {
        console.error('[PAYPAL WEBHOOK] Failed to send payment-failed email:', emailErr.message);
      }

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
