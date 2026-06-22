'use strict';

/**
 * Stripe Webhook Controller
 * Handles all Stripe webhook events with proper security and error handling
 */

module.exports = {
  /**
   * Handle Stripe Webhook Events
   */
  async handleWebhook(ctx) {
    // ─────────────────────────────────────────────────────────────────────
    // SECURITY — signature verification is MANDATORY in all environments.
    //
    // Pre-fix this handler had a NODE_ENV === 'development' bypass that
    // accepted ctx.request.body as the canonical event whenever the raw
    // body was unavailable, with verification skipped entirely. A
    // misconfigured production deploy (NODE_ENV not set, NODE_ENV stripped
    // by container env, NODE_ENV intentionally set to 'development' for
    // diagnostics) would silently disable verification — any anonymous
    // POSTer could forge a payment_intent.succeeded event and trigger
    // handlePaymentSucceeded → wallet credit. This is now removed; the
    // handler ALWAYS calls stripeService.verifyWebhookSignature and fails
    // closed when STRIPE_WEBHOOK_SECRET / raw body / signature is missing.
    // ─────────────────────────────────────────────────────────────────────

    const signature = ctx.request.headers['stripe-signature'];
    if (!signature) {
      console.error('[STRIPE WEBHOOK] ❌ Missing signature header');
      return ctx.badRequest('Missing signature header');
    }

    // Raw body is the Stripe-signed payload. Without it we cannot verify
    // — fail closed (no reconstruction from parsed body).
    const rawBody =
      ctx.request.body?.[Symbol.for('unparsedBody')] ||
      ctx.request.body?._unparsedBody ||
      ctx.request.rawBody;
    if (!rawBody) {
      console.error('[STRIPE WEBHOOK] ❌ Raw body unavailable — signature cannot be verified');
      return ctx.badRequest('Raw body required for signature verification');
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[STRIPE WEBHOOK] ❌ CRITICAL: STRIPE_WEBHOOK_SECRET not configured');
      return ctx.internalServerError('Webhook verification not configured');
    }

    try {
      const stripeService = strapi.service('api::transaction.stripe-service');
      const event = stripeService.verifyWebhookSignature(rawBody, signature, webhookSecret);

      console.log(`[STRIPE WEBHOOK] 📣 Received event: ${event.type}, ID: ${event.id}`);

      // Handle different event types
      switch (event.type) {
        case 'payment_intent.succeeded':
          await handlePaymentSucceeded(event.data.object);
          break;

        case 'payment_intent.payment_failed':
          await handlePaymentFailed(event.data.object);
          break;

        case 'payment_intent.canceled':
          await handlePaymentCanceled(event.data.object);
          break;

        case 'charge.refunded':
          await handleChargeRefunded(event.data.object);
          break;

        case 'payment_intent.processing':
          console.log(`[STRIPE WEBHOOK] ℹ️ Payment processing: ${event.data.object.id}`);
          break;

        case 'payment_intent.requires_action':
          console.log(`[STRIPE WEBHOOK] ℹ️ Payment requires action: ${event.data.object.id}`);
          break;

        case 'payment_method.attached':
          console.log(`[STRIPE WEBHOOK] ℹ️ Payment method attached: ${event.data.object.id}`);
          break;

        case 'payment_intent.requires_payment_method':
          console.log(`[STRIPE WEBHOOK] ℹ️ Payment requires payment method: ${event.data.object.id}`);
          // This happens when 3D Secure fails or payment method is invalid
          await handlePaymentFailed(event.data.object);
          break;

        case 'payment_intent.created':
          console.log(`[STRIPE WEBHOOK] ℹ️ Payment intent created: ${event.data.object.id}`);
          // Just log, no action needed
          break;

        default:
          // Pre-fix dumped `JSON.stringify(event, null, 2)` here — the
          // event object contains card metadata, billing address, and
          // (depending on the event) tokenised payment-method handles.
          // Log only the event-type label; payload stays on Stripe.
          console.log(`[STRIPE WEBHOOK] ℹ️ Unhandled event type: ${event.type}`);
      }

      // Always return 200 to acknowledge receipt
      return ctx.send({ 
        received: true, 
        eventType: event.type,
        eventId: event.id
      });

    } catch (error) {
      // Log full error server-side; do NOT echo error.message in the
      // response. A forged-webhook attacker can probe failure modes via
      // the response body otherwise.
      console.error('[STRIPE WEBHOOK] ❌ Webhook processing failed:', error);
      return ctx.badRequest('Webhook processing failed');
    }
  },

  /**
   * Manually mark a transaction as failed (for cases where webhook wasn't received)
   */
  async markTransactionFailed(ctx) {
    try {
      const { paymentIntentId } = ctx.request.body;
      
      if (!paymentIntentId) {
        return ctx.badRequest('Payment Intent ID is required');
      }

      console.log(`[STRIPE MANUAL] Manually marking payment intent ${paymentIntentId} as failed`);

      // Find the transaction
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: paymentIntentId },
        populate: ['user_wallet']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      console.log(`[STRIPE MANUAL] Found transaction ${transaction.id}, current status: ${transaction.transactionStatus}`);

      // Check if already processed
      if (transaction.transactionStatus === 'failed') {
        return ctx.send({
          success: true,
          message: 'Transaction already marked as failed',
          transaction: {
            id: transaction.id,
            status: 'failed',
            paymentIntentId: paymentIntentId
          }
        });
      }

      // Update transaction status
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: {
          transactionStatus: 'failed',
          failedAt: new Date(),
          metadata: {
            ...transaction.metadata,
            failureReason: 'Manually marked as failed - 3D Secure authentication failed',
            failureCode: 'manual_failure',
            manualFailure: true,
            processedAt: new Date().toISOString()
          }
        }
      });

      console.log(`[STRIPE MANUAL] ✅ Successfully marked transaction ${transaction.id} as failed`);

      return ctx.send({
        success: true,
        message: 'Transaction marked as failed',
        transaction: {
          id: transaction.id,
          status: 'failed',
          paymentIntentId: paymentIntentId
        }
      });

    } catch (error) {
      console.error('[STRIPE MANUAL] ❌ Error marking transaction as failed:', error);
      return ctx.badRequest('Failed to mark transaction as failed');
    }
  },

  /**
   * Check and update transaction status from Stripe (for pending transactions)
   */
  async checkTransactionStatus(ctx) {
    try {
      const { paymentIntentId } = ctx.request.body;
      
      if (!paymentIntentId) {
        return ctx.badRequest('Payment Intent ID is required');
      }

      console.log(`[STRIPE CHECK] Checking status for payment intent ${paymentIntentId}`);

      // Find the transaction
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: paymentIntentId },
        populate: ['user_wallet']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      console.log(`[STRIPE CHECK] Found transaction ${transaction.id}, current status: ${transaction.transactionStatus}`);

      // If already processed, return current status
      if (transaction.transactionStatus !== 'pending') {
        return ctx.send({
          success: true,
          message: 'Transaction already processed',
          transaction: {
            id: transaction.id,
            status: transaction.transactionStatus,
            paymentIntentId: paymentIntentId
          }
        });
      }

      // Check with Stripe API
      const stripeService = strapi.service('api::transaction.stripe-service');
      const paymentIntent = await stripeService.retrievePaymentIntent(paymentIntentId);

      console.log(`[STRIPE CHECK] Stripe payment intent status: ${paymentIntent.status}`);

      let newStatus = transaction.transactionStatus;
      let updateData = {};

      switch (paymentIntent.status) {
        case 'succeeded':
          newStatus = 'success';
          // Handle success (update wallet balance, etc.)
          await handlePaymentSucceeded(paymentIntent);
          break;

        case 'requires_payment_method':
        case 'canceled':
          newStatus = 'failed';
          updateData = {
            transactionStatus: 'failed',
            failedAt: new Date(),
            metadata: {
              ...transaction.metadata,
              failureReason: `Payment ${paymentIntent.status}`,
              failureCode: paymentIntent.status,
              stripeStatus: paymentIntent.status,
              processedAt: new Date().toISOString()
            }
          };
          break;

        case 'processing':
          newStatus = 'pending';
          console.log(`[STRIPE CHECK] Payment still processing`);
          break;

        default:
          console.log(`[STRIPE CHECK] Unknown payment intent status: ${paymentIntent.status}`);
          newStatus = 'pending';
      }

      // Update transaction if status changed
      if (newStatus !== transaction.transactionStatus && Object.keys(updateData).length > 0) {
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: updateData
        });
        console.log(`[STRIPE CHECK] ✅ Updated transaction ${transaction.id} to ${newStatus}`);
      }

      return ctx.send({
        success: true,
        message: `Transaction status checked: ${newStatus}`,
        transaction: {
          id: transaction.id,
          status: newStatus,
          paymentIntentId: paymentIntentId,
          stripeStatus: paymentIntent.status
        }
      });

    } catch (error) {
      console.error('[STRIPE CHECK] ❌ Error checking transaction status:', error);
      return ctx.badRequest('Failed to check transaction status');
    }
  }
};

/**
 * Handle successful payment
 */
async function handlePaymentSucceeded(paymentIntent) {
  try {
    console.log(`[STRIPE] 💰 Payment succeeded: ${paymentIntent.id}`);

    let invoiceTarget = null; // capture {transaction, user} for after-tx invoice creation

    // ✅ BEST PRACTICE: Use database transaction with row-level locking to prevent race conditions
    // This ensures only ONE caller (webhook, inline polling, manual reconciliation) can process the same transaction at a time
    await strapi.db.transaction(async ({ trx }) => {
      const knex = strapi.db.connection;

      // ✅ SECURE: Lock the transaction row first (SELECT FOR UPDATE equivalent)
      const lockedRows = await knex('transactions')
        .where('gateway_transaction_id', paymentIntent.id)
        .forUpdate() // Database-level lock
        .transacting(trx);

      if (!lockedRows || lockedRows.length === 0) {
        console.error(`[STRIPE] ❌ Transaction not found for Payment Intent: ${paymentIntent.id}`);
        // This might be a payment not initiated by us, just log and return
        return;
      }

      const transactionRow = lockedRows[0];

      // ✅ CRITICAL IDEMPOTENCY CHECK: Now safe from race conditions under row lock
      if (transactionRow.transaction_status === 'success') {
        console.log(`[STRIPE] ℹ️ Transaction ${transactionRow.id} already processed, skipping (idempotent)`);
        return;
      }

      // Re-fetch with Strapi shape to get populated relations
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { id: transactionRow.id },
        populate: ['user_wallet', 'users_permissions_user']
      });

      console.log(`[STRIPE] Processing transaction ${transaction.id} for Payment Intent ${paymentIntent.id}`);

      // Get wallet ID from metadata or transaction.
      // Stripe metadata values are always strings; coerce so the integer-keyed
      // wallet lookup doesn't silently miss under stricter DB drivers.
      const metadataWalletId = paymentIntent.metadata?.walletId
        ? Number(paymentIntent.metadata.walletId)
        : null;
      const walletId = (Number.isFinite(metadataWalletId) ? metadataWalletId : null)
        || transaction.user_wallet?.id;

      if (!walletId) {
        console.error(`[STRIPE] ❌ No wallet ID found for Payment Intent ${paymentIntent.id}`);
        // Mark transaction as failed
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: 'failed',
            metadata: {
              ...transaction.metadata,
              error: 'No wallet ID found',
              processedAt: new Date().toISOString()
            }
          }
        });
        return;
      }

      // Use database transaction for atomic updates
      try {
        // Find the wallet
        const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: walletId },
          populate: ['users_permissions_user']
        });

        if (!wallet) {
          throw new Error(`Wallet ${walletId} not found`);
        }

        // Calculate new balance
        // ─────────────────────────────────────────────────────────────────
        // Audit M11 — amount-mismatch cross-check.
        // Before any wallet write, validate that Stripe actually charged
        // the amount we asked it to charge. If they diverge, refuse the
        // credit and mark the tx failed.
        //
        // expectedChargeCents lives in transaction.metadata (set in
        // createPayment via computeFees). Legacy pending rows from before
        // the fix may lack it — we grace-period those for 30 days.
        // ─────────────────────────────────────────────────────────────────
        {
          const expectedChargeCents = Number(transaction.metadata?.expectedChargeCents);
          const actualChargeCents = Number(paymentIntent.amount);
          const GRACE_PERIOD_END = new Date('2026-07-16T00:00:00Z');

          if (Number.isFinite(expectedChargeCents) && expectedChargeCents > 0) {
            if (actualChargeCents !== expectedChargeCents) {
              strapi.log.error(
                `[STRIPE WEBHOOK] amount mismatch — REFUSING wallet credit. ` +
                `paymentIntent.amount=${actualChargeCents}c expected=${expectedChargeCents}c ` +
                `tx=${transaction.id} pi=${paymentIntent.id}`
              );
              await strapi.entityService.update('api::transaction.transaction', transaction.id, {
                data: {
                  transactionStatus: 'failed',
                  metadata: {
                    ...transaction.metadata,
                    error: 'amount_mismatch',
                    actualChargeCents,
                    expectedChargeCents,
                    processedAt: new Date().toISOString(),
                  },
                },
              });
              return; // no wallet credit
            }
          } else if (new Date() > GRACE_PERIOD_END) {
            strapi.log.error(
              `[STRIPE WEBHOOK] missing expectedChargeCents post-grace-period — REFUSING. tx=${transaction.id}`
            );
            await strapi.entityService.update('api::transaction.transaction', transaction.id, {
              data: { transactionStatus: 'failed', metadata: { ...transaction.metadata, error: 'missing_expected_amount' } },
            });
            return;
          } else {
            strapi.log.warn(
              `[STRIPE WEBHOOK] legacy pending tx missing expectedChargeCents (grace period); ` +
              `tx=${transaction.id} pi=${paymentIntent.id} actualCents=${actualChargeCents}`
            );
          }
        }

        // Calculate new balance
        const currentMainBalance = parseFloat(wallet.mainBalance || 0);
        const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
        const transactionAmount = parseFloat(transaction.amount);
        const newMainBalance = currentMainBalance + transactionAmount;
        const newTotalBalance = newMainBalance + currentPromoBalance;

        console.log(`[STRIPE] 💵 Updating wallet ${walletId}: $${currentMainBalance} + $${transactionAmount} = $${newMainBalance}`);

        // Update wallet balance
        await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
          data: {
            mainBalance: newMainBalance,
            balance: newTotalBalance
          }
        });

        // Update transaction status
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: 'success',
            completedAt: new Date(),
            metadata: {
              ...transaction.metadata,
              stripePaymentIntent: {
                id: paymentIntent.id,
                amount: paymentIntent.amount,
                currency: paymentIntent.currency,
                status: paymentIntent.status
              },
              processedAt: new Date().toISOString(),
              balanceBefore: currentMainBalance,
              balanceAfter: newMainBalance
            }
          }
        });

        console.log(`[STRIPE] ✅ Transaction ${transaction.id} completed successfully`);

        // Real-time push so the client wallet UI reflects the deposit
        // instantly. Best-effort — webhook success must not depend on it.
        try {
          const targetUserId = wallet.users_permissions_user?.id;
          if (targetUserId) {
            await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
              targetUserId,
              'stripe_deposit',
              { transactionId: transaction.id, paymentIntentId: paymentIntent.id, amount: transactionAmount, walletId: wallet.id }
            );
          }
        } catch (emitErr) {
          console.warn('[STRIPE] emitBalanceUpdate failed (non-fatal):', emitErr.message);
        }

        // Save target for invoice creation outside the lock
        invoiceTarget = { transaction, user: wallet.users_permissions_user };

      } catch (error) {
        console.error('[STRIPE] ❌ Error updating wallet balance:', error);

        // Mark transaction as failed
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: 'failed',
            failedAt: new Date(),
            metadata: {
              ...transaction.metadata,
              error: error.message,
              processedAt: new Date().toISOString()
            }
          }
        });

        throw error;
      }
    });

    // Invoice creation runs OUTSIDE the locked block (fire-and-forget)
    if (invoiceTarget) {
      createInvoiceForTransaction(invoiceTarget.transaction, invoiceTarget.user)
        .then(() => {
          console.log(`[STRIPE] ✅ Invoice created for transaction ${invoiceTarget.transaction.id}`);
        })
        .catch((invoiceError) => {
          console.error(`[STRIPE] ⚠️ Invoice creation failed for transaction ${invoiceTarget.transaction.id}:`, invoiceError);
          // Don't throw error - invoice can be created later
        });
    }

  } catch (error) {
    console.error('[STRIPE] ❌ Error handling payment success:', error);
    // Don't throw - we already logged the error
  }
}

/**
 * Handle failed payment
 */
async function handlePaymentFailed(paymentIntent) {
  try {
    console.log(`[STRIPE] ❌ Payment failed: ${paymentIntent.id}`);
    console.log(`[STRIPE] Payment Intent status: ${paymentIntent.status}`);
    console.log(`[STRIPE] Last payment error:`, paymentIntent.last_payment_error);

    const transaction = await strapi.db.query('api::transaction.transaction').findOne({
      where: { gatewayTransactionId: paymentIntent.id },
      populate: ['user_wallet']
    });

    if (!transaction) {
      console.error(`[STRIPE] Transaction not found for failed Payment Intent: ${paymentIntent.id}`);
      console.error(`[STRIPE] Available transactions with gatewayTransactionId:`, await strapi.db.query('api::transaction.transaction').findMany({
        where: { gatewayTransactionId: paymentIntent.id }
      }));
      return;
    }

    console.log(`[STRIPE] Found transaction ${transaction.id}, current status: ${transaction.transactionStatus}`);

    // Check if already processed (idempotency)
    if (transaction.transactionStatus === 'failed') {
      console.log(`[STRIPE] ℹ️ Transaction ${transaction.id} already marked as failed, skipping`);
      return;
    }

    // Update transaction status
    await strapi.entityService.update('api::transaction.transaction', transaction.id, {
      data: {
        transactionStatus: 'failed',
        failedAt: new Date(),
        metadata: {
          ...transaction.metadata,
          failureReason: paymentIntent.last_payment_error?.message || 'Payment failed',
          failureCode: paymentIntent.last_payment_error?.code,
          failureType: paymentIntent.last_payment_error?.type,
          stripePaymentIntent: {
            id: paymentIntent.id,
            status: paymentIntent.status,
            lastPaymentError: paymentIntent.last_payment_error
          },
          processedAt: new Date().toISOString()
        }
      }
    });

    console.log(`[STRIPE] ✅ Successfully marked transaction ${transaction.id} as failed`);
    console.log(`[STRIPE] Failure reason: ${paymentIntent.last_payment_error?.message || 'Unknown error'}`);

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
          notes: paymentIntent.last_payment_error?.message || 'Payment failed',
          flags: { is_payment_failed: true },
          tags: ['transaction', 'payment', 'failed', 'stripe'],
        });
      }
    } catch (emailErr) {
      console.error('[STRIPE] Failed to send payment-failed email:', emailErr.message);
    }

  } catch (error) {
    console.error('[STRIPE] ❌ Error handling payment failure:', error);
    console.error('[STRIPE] Error details:', {
      message: error.message,
      stack: error.stack,
      paymentIntentId: paymentIntent.id
    });
  }
}

/**
 * Handle canceled payment
 */
async function handlePaymentCanceled(paymentIntent) {
  try {
    console.log(`[STRIPE] 🚫 Payment canceled: ${paymentIntent.id}`);

    const transaction = await strapi.db.query('api::transaction.transaction').findOne({
      where: { gatewayTransactionId: paymentIntent.id }
    });

    if (!transaction) {
      console.error(`[STRIPE] Transaction not found for canceled Payment Intent: ${paymentIntent.id}`);
      return;
    }

    await strapi.entityService.update('api::transaction.transaction', transaction.id, {
      data: {
        transactionStatus: 'cancelled',
        canceledAt: new Date(),
        metadata: {
          ...transaction.metadata,
          processedAt: new Date().toISOString()
        }
      }
    });

    console.log(`[STRIPE] ✅ Marked transaction ${transaction.id} as canceled`);

  } catch (error) {
    console.error('[STRIPE] ❌ Error handling payment cancellation:', error);
  }
}

/**
 * Handle refunded charge
 */
async function handleChargeRefunded(charge) {
  try {
    console.log(`[STRIPE] 🔄 Charge refunded: ${charge.id}`);

    const paymentIntentId = charge.payment_intent;
    const transaction = await strapi.db.query('api::transaction.transaction').findOne({
      where: { gatewayTransactionId: paymentIntentId },
      populate: ['user_wallet']
    });

    if (!transaction) {
      console.error(`[STRIPE] Transaction not found for refunded charge: ${charge.id}`);
      return;
    }

    // Create refund transaction
    const refundAmount = charge.amount_refunded / 100;
    await strapi.entityService.create('api::transaction.transaction', {
      data: {
        type: 'refund',
        amount: refundAmount,
        netAmount: refundAmount,
        currency: charge.currency.toUpperCase(),
        gateway: 'stripe',
        gatewayTransactionId: charge.id,
        transactionStatus: 'success',
        user_wallet: transaction.user_wallet?.id,
        users_permissions_user: transaction.users_permissions_user,
        fund_source: 'main_fund',
        metadata: {
          originalTransactionId: transaction.id,
          chargeId: charge.id,
          refundReason: 'Charge refunded',
          processedAt: new Date().toISOString()
        },
        publishedAt: new Date()
      }
    });

    // Update wallet balance
    const wallet = transaction.user_wallet;
    if (wallet) {
      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      const newMainBalance = Math.max(0, currentMainBalance - refundAmount);
      const newTotalBalance = newMainBalance + currentPromoBalance;

      await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
        data: {
          mainBalance: newMainBalance,
          balance: newTotalBalance
        }
      });

      console.log(`[STRIPE] ✅ Refund processed: $${refundAmount} deducted from wallet ${wallet.id}`);

      // Real-time push so the user sees the refund debit immediately.
      try {
        const walletWithUser = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: wallet.id },
          populate: ['users_permissions_user'],
        });
        const targetUserId = walletWithUser?.users_permissions_user?.id;
        if (targetUserId) {
          await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
            targetUserId,
            'stripe_refund',
            { transactionId: transaction.id, chargeId: charge.id, refundAmount, walletId: wallet.id }
          );
        }
      } catch (emitErr) {
        console.warn('[STRIPE] emitBalanceUpdate (refund) failed (non-fatal):', emitErr.message);
      }
    }

  } catch (error) {
    console.error('[STRIPE] ❌ Error handling refund:', error);
  }
}

/**
 * Create invoice for successful transaction
 */
async function createInvoiceForTransaction(transaction, user) {
  try {
    const invoiceNumber = `INV-${Date.now()}-${transaction.id}`;

    const invoice = await strapi.entityService.create('api::invoice.invoice', {
      data: {
        invoiceNumber,
        invoiceDate: new Date(),
        user: user?.id,
        transactionId: transaction.id.toString(),
        billingName: user?.username || 'Customer',
        billingAddress: 'Address on file',
        billingCity: 'City',
        billingCountry: 'Country',
        billingPincode: '000000',
        lineItems: [{
          description: 'Wallet Deposit via Stripe',
          amount: transaction.amount,
          quantity: 1
        }],
        subtotal: transaction.amount,
        taxAmount: 0,
        totalAmount: transaction.amount,
        currency: transaction.currency || 'USD',
        status: 'paid',
        pdfUrl: `/invoices/${invoiceNumber}.pdf`,
        notes: `Stripe payment - Transaction ${transaction.id}`,
        publishedAt: new Date()
      }
    });

    // Link invoice to transaction
    await strapi.entityService.update('api::transaction.transaction', transaction.id, {
      data: { invoice: invoice.id }
    });

    console.log(`[STRIPE] ✅ Invoice created: ${invoice.invoiceNumber}`);
    return invoice;
  } catch (error) {
    console.error('[STRIPE] ❌ Invoice creation failed:', error);
    throw error;
  }
}

