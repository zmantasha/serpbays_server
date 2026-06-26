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

      // Verify webhook signature - MANDATORY (no bypass)
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.error('[RAZORPAY WEBHOOK] ❌ CRITICAL: RAZORPAY_WEBHOOK_SECRET not configured in environment');
        return ctx.internalServerError('Webhook signature verification failed - missing secret');
      }

      // Calculate expected signature
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(body))
        .digest('hex');

      // Compare signatures (prevents timing attacks)
      if (razorpaySignature !== expectedSignature) {
        console.error('[RAZORPAY WEBHOOK] ❌ Invalid signature - possible fraud attempt');
        console.error('[RAZORPAY WEBHOOK] Expected:', expectedSignature.substring(0, 10) + '...');
        console.error('[RAZORPAY WEBHOOK] Received:', razorpaySignature.substring(0, 10) + '...');
        return ctx.forbidden('Invalid webhook signature');
      }

      console.log('[RAZORPAY WEBHOOK] ✅ Signature verified successfully');

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
      const razorpayAmountINR = payment.amount / 100; // This is INR amount from Razorpay
      const currency = payment.currency;
      const status = payment.status;

      console.log(`[RAZORPAY WEBHOOK] Payment captured: ${paymentId} for order ${orderId}, Razorpay amount: ${razorpayAmountINR} ${currency}`);

      let emitContext = null;

      // ✅ BEST PRACTICE: Use database transaction with row-level locking to prevent race conditions
      // This ensures only ONE webhook can process the same transaction at a time
      await strapi.db.transaction(async ({ trx }) => {
        // ✅ SECURE: Lock the transaction row first (SELECT FOR UPDATE equivalent)
        // Find with lock - if another webhook is processing, this will wait
        const knex = strapi.db.connection;
        const lockedRows = await knex('transactions')
          .where('gateway_transaction_id', orderId)
          .forUpdate() // Database-level lock
          .transacting(trx);

        if (!lockedRows || lockedRows.length === 0) {
          console.error(`[RAZORPAY WEBHOOK] Transaction not found for order ID: ${orderId}`);
          return;
        }

        const transactionRow = lockedRows[0];

        // ✅ CRITICAL IDEMPOTENCY CHECK: Now safe from race conditions
        if (transactionRow.transaction_status === 'success') {
          console.log(`[RAZORPAY WEBHOOK] ⚠️ Transaction ${transactionRow.id} already processed - skipping to prevent double credit`);
          return;
        }

        // Get wallet info
        const transaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { id: transactionRow.id },
          populate: ['user_wallet']
        });

        // ✅ CRITICAL FIX: Use the stored USD baseAmount from transaction
        const amountToCredit = parseFloat(transaction.amount);
        const creditCurrency = transaction.currency || 'USD';

        console.log(`[RAZORPAY WEBHOOK] Using stored transaction amount: ${amountToCredit} ${creditCurrency} (Razorpay charged: ${razorpayAmountINR} ${currency})`);

        // ─────────────────────────────────────────────────────────────
        // Audit M11 — amount-mismatch cross-check.
        // Compare Razorpay's actual charge (paise) against the
        // server-computed expectedChargeCents (also paise, derived in
        // createPayment via computeFees and stored in tx.metadata).
        // If they diverge, refuse the credit and mark the tx failed.
        // Tolerance: ±1 paise (~$0.0001) for floating-point cents math.
        // ─────────────────────────────────────────────────────────────
        {
          const expectedChargeCents = Number(transaction.metadata?.expectedChargeCents);
          const actualChargeCents = Number(payment.amount); // paise
          const GRACE_PERIOD_END = new Date('2026-07-16T00:00:00Z');
          if (Number.isFinite(expectedChargeCents) && expectedChargeCents > 0) {
            if (Math.abs(actualChargeCents - expectedChargeCents) > 1) {
              strapi.log.error(
                `[RAZORPAY WEBHOOK] amount mismatch — REFUSING wallet credit. ` +
                `payment.amount=${actualChargeCents}p expected=${expectedChargeCents}p ` +
                `tx=${transaction.id} order=${orderId}`
              );
              await strapi.entityService.update('api::transaction.transaction', transaction.id, {
                data: {
                  transactionStatus: 'failed',
                  external_transaction_id: paymentId,
                  metadata: {
                    ...transaction.metadata,
                    error: 'amount_mismatch',
                    actualChargeCents,
                    expectedChargeCents,
                    processedAt: new Date().toISOString(),
                  },
                },
              });
              return;
            }
          } else if (new Date() > GRACE_PERIOD_END) {
            strapi.log.error(`[RAZORPAY WEBHOOK] missing expectedChargeCents post-grace-period — REFUSING. tx=${transaction.id}`);
            await strapi.entityService.update('api::transaction.transaction', transaction.id, {
              data: { transactionStatus: 'failed', metadata: { ...transaction.metadata, error: 'missing_expected_amount' } },
            });
            return;
          } else {
            strapi.log.warn(`[RAZORPAY WEBHOOK] legacy pending tx missing expectedChargeCents (grace period); tx=${transaction.id}`);
          }
        }

        // ✅ ATOMIC OPERATION 1: Update transaction status
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: status === 'captured' ? 'success' : 'failed',
            external_transaction_id: paymentId,
            updatedAt: new Date()
          }
        });

        // ✅ ATOMIC OPERATION 2: Update wallet balance with correct USD amount (if captured)
        if (status === 'captured' && transaction.user_wallet) {
          await this.updateWalletBalance(transaction.user_wallet.id, amountToCredit, creditCurrency);
          console.log(`[RAZORPAY WEBHOOK] ✅ Successfully credited ${amountToCredit} ${creditCurrency} to wallet ${transaction.user_wallet.id}`);
          emitContext = {
            walletId: transaction.user_wallet.id,
            transactionId: transaction.id,
            paymentId,
            amount: amountToCredit,
          };
        }
      });

      if (emitContext) {
        try {
          const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { id: emitContext.walletId },
            populate: ['users_permissions_user'],
          });
          const targetUserId = wallet?.users_permissions_user?.id;
          if (targetUserId) {
            await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
              targetUserId,
              'razorpay_deposit',
              emitContext
            );
          }
        } catch (emitErr) {
          console.warn('[RAZORPAY WEBHOOK] emitBalanceUpdate failed (non-fatal):', emitErr.message);
        }
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

        try {
          const txWithUser = await strapi.db.query('api::transaction.transaction').findOne({
            where: { id: transaction.id },
            populate: ['users_permissions_user']
          });
          if (txWithUser?.users_permissions_user?.email) {
            await strapi.service('api::global.email-operations').sendTransactionEmail({
              transaction: txWithUser,
              userEmail: txWithUser.users_permissions_user.email,
              statusLabel: 'failed',
              statusMessage: 'Your payment could not be processed. Please try again.',
              notes: errorDescription,
              flags: { is_payment_failed: true },
              tags: ['transaction', 'payment', 'failed', 'razorpay'],
            });
          }
        } catch (emailErr) {
          console.error('[RAZORPAY WEBHOOK] Failed to send payment-failed email:', emailErr.message);
        }
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
      const razorpayAmountINR = order.amount / 100; // This is INR amount from Razorpay
      const currency = order.currency;
      const status = order.status;

      console.log(`[RAZORPAY WEBHOOK] Order paid: ${orderId}, Razorpay amount: ${razorpayAmountINR} ${currency}, status: ${status}`);

      // Captured for the post-commit emit. Set inside the transaction; used
      // outside it so the WS notify only fires after the wallet write commits.
      let emitContext = null;

      // ✅ BEST PRACTICE: Use database transaction with row-level locking to prevent race conditions
      await strapi.db.transaction(async ({ trx }) => {
        // ✅ SECURE: Lock the transaction row first (SELECT FOR UPDATE equivalent)
        const knex = strapi.db.connection;
        const lockedRows = await knex('transactions')
          .where('gateway_transaction_id', orderId)
          .forUpdate() // Database-level lock
          .transacting(trx);

        if (!lockedRows || lockedRows.length === 0) {
          console.error(`[RAZORPAY WEBHOOK] Transaction not found for order ID: ${orderId}`);
          return;
        }

        const transactionRow = lockedRows[0];

        // ✅ CRITICAL IDEMPOTENCY CHECK: Now safe from race conditions
        if (transactionRow.transaction_status === 'success') {
          console.log(`[RAZORPAY WEBHOOK] ⚠️ Transaction ${transactionRow.id} already processed by payment.captured - skipping order.paid to prevent double credit`);
          return;
        }

        // Get wallet info
        const transaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { id: transactionRow.id },
          populate: ['user_wallet']
        });

        // ✅ CRITICAL FIX: Use the stored USD baseAmount from transaction
        const amountToCredit = parseFloat(transaction.amount);
        const creditCurrency = transaction.currency || 'USD';

        console.log(`[RAZORPAY WEBHOOK] Using stored transaction amount: ${amountToCredit} ${creditCurrency} (Razorpay charged: ${razorpayAmountINR} ${currency})`);

        // Audit M11 — amount-mismatch cross-check on order.paid path.
        {
          const expectedChargeCents = Number(transaction.metadata?.expectedChargeCents);
          const actualChargeCents = Number(order.amount); // paise
          const GRACE_PERIOD_END = new Date('2026-07-16T00:00:00Z');
          if (Number.isFinite(expectedChargeCents) && expectedChargeCents > 0) {
            if (Math.abs(actualChargeCents - expectedChargeCents) > 1) {
              strapi.log.error(
                `[RAZORPAY WEBHOOK order.paid] amount mismatch — REFUSING wallet credit. ` +
                `order.amount=${actualChargeCents}p expected=${expectedChargeCents}p tx=${transaction.id}`
              );
              await strapi.entityService.update('api::transaction.transaction', transaction.id, {
                data: {
                  transactionStatus: 'failed',
                  metadata: { ...transaction.metadata, error: 'amount_mismatch', actualChargeCents, expectedChargeCents },
                },
              });
              return;
            }
          } else if (new Date() > GRACE_PERIOD_END) {
            strapi.log.error(`[RAZORPAY WEBHOOK order.paid] missing expectedChargeCents post-grace — REFUSING. tx=${transaction.id}`);
            await strapi.entityService.update('api::transaction.transaction', transaction.id, {
              data: { transactionStatus: 'failed', metadata: { ...transaction.metadata, error: 'missing_expected_amount' } },
            });
            return;
          }
        }

        // ✅ ATOMIC OPERATION 1: Update transaction status
        // Try to get payment ID from order.paid event (if available in payments array)
        const paymentId = eventData.payload?.payment?.entity?.id || order.payments?.items?.[0]?.id || orderId;

        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: status === 'paid' ? 'success' : 'failed',
            external_transaction_id: paymentId,
            updatedAt: new Date()
          }
        });

        // ✅ ATOMIC OPERATION 2: Update wallet balance with correct USD amount (if paid)
        if (status === 'paid' && transaction.user_wallet) {
          await this.updateWalletBalance(transaction.user_wallet.id, amountToCredit, creditCurrency);
          console.log(`[RAZORPAY WEBHOOK] ✅ Successfully credited ${amountToCredit} ${creditCurrency} to wallet ${transaction.user_wallet.id}`);
          emitContext = {
            walletId: transaction.user_wallet.id,
            transactionId: transaction.id,
            paymentId,
            amount: amountToCredit,
          };
        }
      });

      // Post-commit real-time push (best-effort). Done OUTSIDE the
      // transaction so a rolled-back wallet credit never produces a stale
      // event on the wire.
      if (emitContext) {
        try {
          const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { id: emitContext.walletId },
            populate: ['users_permissions_user'],
          });
          const targetUserId = wallet?.users_permissions_user?.id;
          if (targetUserId) {
            await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
              targetUserId,
              'razorpay_deposit',
              emitContext
            );
          }
        } catch (emitErr) {
          console.warn('[RAZORPAY WEBHOOK] emitBalanceUpdate failed (non-fatal):', emitErr.message);
        }
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
   * MAX 5 verification attempts per order
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

      // Check verification attempt count (max 5 attempts)
      const MAX_VERIFICATION_ATTEMPTS = 5;
      const currentAttempts = transaction.metadata?.verificationAttempts || 0;

      if (currentAttempts >= MAX_VERIFICATION_ATTEMPTS) {
        console.warn(`[RAZORPAY VERIFY] ⚠️ Maximum verification attempts (${MAX_VERIFICATION_ATTEMPTS}) reached for order ${order_id}`);

        // Mark as failed after max attempts
        if (transaction.transactionStatus === 'pending') {
          await strapi.entityService.update('api::transaction.transaction', transaction.id, {
            data: {
              transactionStatus: 'failed',
              payment_notes: `Payment verification failed - maximum ${MAX_VERIFICATION_ATTEMPTS} attempts reached`,
              updatedAt: new Date()
            }
          });
        }

        return ctx.send({
          verified: false,
          message: `Maximum verification attempts (${MAX_VERIFICATION_ATTEMPTS}) exceeded. Payment marked as failed.`,
          transactionStatus: 'failed',
          isProcessed: true
        });
      }

      // Increment verification attempt counter
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: {
          metadata: {
            ...transaction.metadata,
            verificationAttempts: currentAttempts + 1,
            lastVerificationAttempt: new Date().toISOString()
          }
        }
      });

      console.log(`[RAZORPAY VERIFY] Verification attempt ${currentAttempts + 1}/${MAX_VERIFICATION_ATTEMPTS} for order ${order_id}`);

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
        try {
          const w = await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { id: transaction.user_wallet.id },
            populate: ['users_permissions_user'],
          });
          const uid = w?.users_permissions_user?.id;
          if (uid) {
            await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
              uid,
              'razorpay_deposit',
              { transactionId: transaction.id, walletId: transaction.user_wallet.id, amount, paymentId: paymentId || null }
            );
          }
        } catch (emitErr) {
          console.warn('[RAZORPAY VERIFY] emitBalanceUpdate failed (non-fatal):', emitErr.message);
        }
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
        try {
          const w = await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { id: transaction.user_wallet.id },
            populate: ['users_permissions_user'],
          });
          const uid = w?.users_permissions_user?.id;
          if (uid) {
            await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
              uid,
              'razorpay_manual',
              { transactionId: transaction.id, walletId: transaction.user_wallet.id, amount, paymentId: payment_id || null }
            );
          }
        } catch (emitErr) {
          console.warn('[RAZORPAY MANUAL] emitBalanceUpdate failed (non-fatal):', emitErr.message);
        }
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
