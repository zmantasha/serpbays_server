'use strict';

/**
 * transaction controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const exchangeRateService = require('../../payment-gateways/services/exchange-rate');

module.exports = createCoreController('api::transaction.transaction', ({ strapi }) => ({
  // Create payment intent
  async createPayment(ctx) {
    try {
      // ═══════════════════════════════════════════════════════════════════
      // Audit M11 fix — server-authoritative payment model.
      //
      // Previously the controller read both `amount` (charge) and
      // `baseAmount` (wallet credit) from the request body and trusted
      // them independently. That let an attacker rewrite the body via
      // DevTools to `{amount: 1, baseAmount: 1000}`, pay $1 via Stripe,
      // and have $1000 credited to wallet (verified $999/tx exploit).
      //
      // Trust model now:
      //   - `userIntent` (= wallet credit) is the ONLY money value we
      //     read from the client. The legacy contract sent both `amount`
      //     (charge total) and `baseAmount` (wallet credit). We prefer
      //     `baseAmount` (it's the user's actual intent), falling back
      //     to `amount` for clients that don't send baseAmount.
      //   - Server derives chargeUSD and expectedChargeCents from
      //     `userIntent` via `computeFees`. Both wallet credit and
      //     gateway charge are computed from the SAME server-only math.
      //     They cannot diverge.
      //   - Any client-supplied `amount` that differs from the
      //     server-derived chargeUSD is logged as a tamper attempt.
      // ═══════════════════════════════════════════════════════════════════
      const { amount, baseAmount, currency: clientCurrency, gateway } = ctx.request.body;
      const userId = ctx.state?.user?.id;
      let wallet;

      // ═══════════════════════════════════════════════════════════════════
      // Audit Wave-3 Vector A — server-authoritative currency.
      //
      // Pre-fix: the client's `currency` flowed straight through to
      // `createStripePaymentIntent(amount, currency, …)`, PayPal's
      // `createOrder(amount, currency, …)`, and PhonePe. Stripe accepted
      // e.g. `{amount: 100, currency: 'IDR'}` and created a PaymentIntent
      // for 100 IDR (≈ $0.006) while the wallet credit (USD intent) stayed
      // at $100 — up to ~17,000× inflation per call.
      //
      // The wallet is USD-denominated and there's no funding flow that
      // legitimately needs non-USD for these three gateways. Force USD
      // server-side. Razorpay is unaffected — its branch in `computeFees`
      // already hardcodes 'INR' for the gateway charge.
      // ═══════════════════════════════════════════════════════════════════
      const CURRENCY_BY_GATEWAY = { stripe: 'USD', paypal: 'USD', phonepe: 'USD', razorpay: 'INR' };
      const lowerGateway = (gateway || '').toLowerCase();
      const serverCurrency = CURRENCY_BY_GATEWAY[lowerGateway] || 'USD';
      if (clientCurrency && clientCurrency.toUpperCase() !== serverCurrency) {
        strapi.log.warn(
          `[CURRENCY_TAMPER] user=${userId} ip=${ctx.request.ip} gateway=${gateway} ` +
          `client-supplied currency=${clientCurrency} server-forced=${serverCurrency}`
        );
      }
      const currency = serverCurrency;

      console.log("[PAYMENT] Received payment request:", {
        amount: amount,
        baseAmount: baseAmount,
        currency: currency,
        gateway: gateway,
        amountType: typeof amount,
        baseAmountType: typeof baseAmount,
      })

      if (!amount || !gateway) {
        return ctx.badRequest('Amount and gateway are required');
      }

      // Pick wallet-credit intent — prefer client's baseAmount (matches
      // legacy contract), fall back to amount. Either way, this is the
      // ONLY money value sourced from the client.
      const userIntentRaw = (baseAmount !== undefined && baseAmount !== null && baseAmount !== '')
        ? baseAmount
        : amount;
      const userIntent = parseFloat(userIntentRaw);
      if (isNaN(userIntent) || userIntent <= 0) {
        return ctx.badRequest('Invalid amount');
      }

      // Maximum-transaction cap applied to the user's INTENT (wallet
      // credit). The derived charge can be slightly higher (e.g. +18%
      // GST for Razorpay) — we hard-cap that below at 2×.
      const MAX_TRANSACTION_AMOUNT = 10000; // $10,000 USD
      if (userIntent > MAX_TRANSACTION_AMOUNT) {
        console.warn(`[PAYMENT SECURITY] Transaction amount ${userIntent} exceeds maximum ${MAX_TRANSACTION_AMOUNT}`);
        return ctx.badRequest(`Maximum transaction amount is $${MAX_TRANSACTION_AMOUNT.toLocaleString()}`);
      }

      // Server-only math: derive charge + wallet credit + expected
      // webhook amount from `userIntent`. No client influence below
      // this line.
      let feeBreakdown;
      try {
        feeBreakdown = await strapi.service('api::transaction.payment').computeFees(gateway, currency, userIntent);
      } catch (e) {
        return ctx.badRequest(`Failed to compute fees: ${e.message}`);
      }
      const parsedAmount       = feeBreakdown.chargeUSD;          // gateway charge (in USD; converted to gateway currency below for Razorpay)
      const parsedBaseAmount   = feeBreakdown.walletCreditUSD;    // wallet credit (USD); == userIntent
      const expectedChargeCents = feeBreakdown.expectedChargeCents;

      // Defense-in-depth cap on the derived charge.
      if (parsedAmount > MAX_TRANSACTION_AMOUNT * 2) {
        strapi.log.error(`[PAYMENT SECURITY] Derived charge ${parsedAmount} exceeds 2× MAX. Refusing.`);
        return ctx.badRequest('Charge amount exceeds maximum allowed.');
      }

      // Audit M11 — log tamper attempts. In legitimate traffic:
      //   - For Stripe/PayPal/PhonePe: client's `amount` should equal
      //     userIntent (no fee added).
      //   - For Razorpay: client's `amount` should equal userIntent × 1.18
      //     (its baseAmount + GST), which equals server's parsedAmount.
      // Anything else is a body-tamper attempt.
      if (amount !== undefined && amount !== null) {
        const clientAmount = parseFloat(amount);
        if (!isNaN(clientAmount) && Math.abs(clientAmount - parsedAmount) > 0.01) {
          strapi.log.warn(
            `[BASEAMOUNT_TAMPER] user=${userId} ip=${ctx.request.ip} ` +
            `gateway=${gateway} clientAmount=${clientAmount} clientBaseAmount=${baseAmount} ` +
            `server-derived chargeUSD=${parsedAmount} walletCredit=${parsedBaseAmount}`
          );
        }
      }

      // For development mode without authentication
      if (!userId && process.env.NODE_ENV !== 'production') {
        // Find an existing wallet - any wallet works since they're unified
        wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({});

        if (!wallet) {
          return ctx.notFound('Wallet not found');
        }
      } else if (!userId) {
        return ctx.unauthorized('You must be logged in');
      } else {
        // Find user's wallet
        wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { users_permissions_user: userId }
        });

        if (!wallet) {
          return ctx.notFound('Wallet not found');
        }
      }

      // Double check that we have a valid wallet
      if (!wallet || !wallet.id) {
        return ctx.notFound('Wallet not found');
      }
      console.log("wallet", wallet)
      // SECURITY: Rate limiting - Check recent payment attempts (20 per hour)
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentAttempts = await strapi.db.query('api::transaction.transaction').count({
        where: {
          users_permissions_user: userId,
          gateway: gateway.toLowerCase(),
          createdAt: {
            $gte: oneHourAgo
          }
        }
      });

      const MAX_PAYMENT_ATTEMPTS_PER_HOUR = 20; // ✅ INCREASED from 5 to allow retries
      if (recentAttempts >= MAX_PAYMENT_ATTEMPTS_PER_HOUR) {
        console.warn(`[PAYMENT SECURITY] Rate limit exceeded for user ${userId} on gateway ${gateway}. Attempts: ${recentAttempts}`);
        return ctx.tooManyRequests(`Too many payment attempts. Please wait before trying again. (Limit: ${MAX_PAYMENT_ATTEMPTS_PER_HOUR} per hour)`);
      }

      console.log(`[PAYMENT] Rate limit check passed: ${recentAttempts}/${MAX_PAYMENT_ATTEMPTS_PER_HOUR} attempts in last hour`);

      // Create payment based on gateway
      let paymentData = null;
      try {
        switch (gateway.toLowerCase()) {
          case 'stripe':
            // Server-side dedup: reuse a recent pending Stripe transaction (within 60s) to avoid duplicate PaymentIntents
            // Skipped when userId is unset (dev-mode unauthenticated path) to avoid cross-user matching.
            const recentPendingStripe = userId ? await strapi.db.query('api::transaction.transaction').findOne({
              where: {
                users_permissions_user: userId,
                gateway: 'stripe',
                transactionStatus: 'pending',
                amount: parsedBaseAmount,
                createdAt: { $gte: new Date(Date.now() - 60_000) }
              },
              populate: ['user_wallet']
            }) : null;

            if (recentPendingStripe && recentPendingStripe.metadata && recentPendingStripe.metadata.paymentIntent) {
              console.log(`[PAYMENT] Reusing recent pending transaction ${recentPendingStripe.id} (within 60s window)`);
              return {
                data: {
                  walletId: wallet.id,
                  paymentData: recentPendingStripe.metadata.paymentIntent
                }
              };
            }

            // Create metadata for the payment intent (include baseAmount for wallet credit)
            const stripeMetadata = {
              walletId: wallet.id.toString(),
              userId: userId ? userId.toString() : 'demo',
              email: wallet.users_permissions_user?.email || 'no-email',
              username: wallet.users_permissions_user?.username || 'unknown',
              baseAmount: parsedBaseAmount.toString(), // Store base amount to credit to wallet
              totalAmount: parsedAmount.toString(), // Store total amount paid
              // Audit M11 — webhook uses this for the amount-mismatch cross-check.
              expectedChargeCents: expectedChargeCents.toString(),
            };

            // Use the enhanced payment service with metadata
            // GDPR: Sanitized logging
            console.log('[STRIPE] Creating payment intent:', {
              currency: currency,
              hasMetadata: !!stripeMetadata
            });

            paymentData = await strapi.service('api::transaction.payment').createStripePaymentIntent(
              parsedAmount, // Use total amount (with fees) for payment
              currency,
              stripeMetadata
            );

            // GDPR: Sanitized logging
            console.log('[STRIPE] Payment intent created successfully');
            break;
          case 'razorpay':
            // Audit M11 — reuse FX rate from computeFees so the rate used to
            // build expectedChargeCents matches the rate used for the actual
            // Razorpay charge. Avoids a webhook false-positive if live FX
            // drifts between the two calls.
            const razorpayConversionRate = feeBreakdown.exchangeRate || 1;
            const razorpayAmountINR = feeBreakdown.chargeNative; // chargeUSD × rate, already includes GST
            console.log(`[RAZORPAY] charge $${parsedAmount} USD × ${razorpayConversionRate} = ₹${razorpayAmountINR.toFixed(2)}`);

            // Create Razorpay order in INR
            paymentData = await strapi.service('api::transaction.payment').createRazorpayOrder(razorpayAmountINR, 'INR');

            // Store conversion info in paymentData for reference
            paymentData.originalAmountUSD = parsedAmount;
            paymentData.conversionRate = razorpayConversionRate;
            paymentData.amountINR = razorpayAmountINR;
            break;
          case 'paypal':
            paymentData = await strapi.service('api::transaction.payment').createPayPalOrder(parsedAmount, currency, {
              walletId: wallet.id,
              userId: userId,
              // Audit M11 — server-derived values flow through PayPal metadata
              // so the webhook can cross-check against the actual PayPal charge.
              baseAmount: parsedBaseAmount,
              expectedChargeCents: expectedChargeCents,
              expectedChargeUSD: parsedAmount,
            });
            break;
          case 'phonepe':
            paymentData = await strapi.service('api::transaction.payment').createPhonePeTransaction(parsedAmount, currency, {
              walletId: wallet.id,
              userId: userId,
              redirectUrl: `${process.env.CLIENT_URL || 'http://localhost:3000'}/wallet?phonepe_return=true`,
              mobileNumber: '' // Optional: can be passed from client
            });
            break;
          default:
            return ctx.badRequest('Invalid payment gateway');
        }

        if (!paymentData) {
          throw new Error('Failed to create payment data');
        }

        // For Stripe, create transaction record upfront with baseAmount (webhook will update it)
        if (gateway.toLowerCase() === 'stripe') {
          // Create pending transaction with baseAmount (amount to credit to wallet)
          const transaction = await strapi.entityService.create('api::transaction.transaction', {
            data: {
              type: 'deposit',
              amount: parsedBaseAmount, // Store base amount (amount to credit to wallet)
              netAmount: parsedBaseAmount,
              currency: currency.toUpperCase(),
              gateway: 'stripe',
              gatewayTransactionId: paymentData.id,
              transactionStatus: 'pending',
              user_wallet: wallet.id,
              users_permissions_user: userId || wallet.users_permissions_user?.id,
              fund_source: 'main_fund',
              metadata: {
                paymentIntent: paymentData,
                walletId: wallet.id,
                userId: userId || wallet.users_permissions_user?.id,
                baseAmount: parsedBaseAmount, // Store for reference
                totalAmount: parsedAmount, // Store total paid for reference
                // Audit M11 — webhook reads this to validate
                // paymentIntent.amount (cents) matches what we asked
                // Stripe to charge. Hard-reject on mismatch.
                expectedChargeCents: expectedChargeCents,
                walletCreditUSD: parsedBaseAmount,
                createdAt: new Date().toISOString()
              },
              publishedAt: new Date()
            },
            populate: ['user_wallet']
          });

          console.log(`[PAYMENT] ✅ Created pending transaction for payment intent`);

          return {
            data: {
              walletId: wallet.id,
              paymentData: paymentData
            }
          };
        }

        // For PayPal, don't create a transaction yet (handled by webhooks)
        if (gateway.toLowerCase() === 'paypal') {
          return {
            data: {
              walletId: wallet.id,
              paymentData: paymentData
            }
          };
        }

        // For PhonePe, return redirect URL
        if (gateway.toLowerCase() === 'phonepe') {
          // Create pending transaction for PhonePe
          const transaction = await strapi.entityService.create('api::transaction.transaction', {
            data: {
              type: 'deposit',
              amount: parsedAmount,
              netAmount: parsedAmount,
              currency: currency,
              gateway: gateway,
              gatewayTransactionId: paymentData.transactionId,
              transactionStatus: 'pending',
              user_wallet: wallet.id,
              users_permissions_user: userId || wallet.users_permissions_user,
              metadata: {
                phonepeData: paymentData,
                walletId: wallet.id,
                userId: userId,
                // Audit M11 — webhook cross-check field. PhonePe was
                // already not exploitable via baseAmount (uses parsedAmount
                // for both charge and credit) but we include this for
                // defense-in-depth + uniform webhook validation.
                expectedChargeCents: expectedChargeCents,
                walletCreditUSD: parsedBaseAmount,
              },
              publishedAt: new Date()
            },
            populate: ['user_wallet']
          });

          console.log(`✅ Created PhonePe transaction successfully`);

          return {
            data: {
              transaction: transaction,
              walletId: wallet.id,
              paymentData: paymentData,
              redirectUrl: paymentData.redirectUrl // PhonePe checkout URL
            }
          };
        }

        // For Razorpay, create a pending transaction
        // Store the base USD amount (what user will get in wallet), but record INR payment details
        const razorpayBaseAmount = gateway.toLowerCase() === 'razorpay' ? parsedBaseAmount : parsedAmount;
        const razorpayINRAmount = paymentData.amountINR || parsedAmount;
        const razorpayRate = paymentData.conversionRate || 1;

        const transaction = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'deposit',
            amount: razorpayBaseAmount, // Store USD amount (what will be credited to wallet)
            netAmount: razorpayBaseAmount,
            currency: 'USD', // Wallet is in USD
            gateway: gateway,
            gatewayTransactionId: paymentData.id,
            transactionStatus: 'pending',
            user_wallet: wallet.id,
            users_permissions_user: userId || wallet.users_permissions_user,
            metadata: {
              paymentData: paymentData,
              walletId: wallet.id,
              userId: userId,
              baseAmountUSD: razorpayBaseAmount,
              paidAmountINR: razorpayINRAmount,
              conversionRate: razorpayRate,
              originalAmountUSD: paymentData.originalAmountUSD || parsedAmount,
              // Audit M11 — webhook validates razorpay payload.amount (paise) === expectedChargeCents.
              expectedChargeCents: expectedChargeCents,
              walletCreditUSD: parsedBaseAmount,
            },
            publishedAt: new Date()
          },
          populate: ['user_wallet']
        });

        console.log(`[RAZORPAY] ✅ Created pending transaction successfully`);

        return { data: { transaction, paymentData } };
      } catch (error) {
        console.error("Payment gateway error:", error);
        return ctx.badRequest(error.message || 'Failed to process payment request');
      }
    } catch (error) {
      console.error("Payment creation error:", error);
      return ctx.badRequest(error.message || 'Failed to create payment');
    }
  },

  // Audit C9 — generic `handleWebhook` method removed.
  // The method dispatched by URL `:gateway` param to inline Stripe / PayPal /
  // Razorpay verification logic that pre-dated the M11 baseAmount fix:
  //  - PayPal branch captured a body-supplied orderID with NO signature check.
  //  - Stripe branch verified signature but credited wallet by
  //    `existingTransaction.amount` with NO `expectedChargeCents` cross-check.
  //  - Razorpay branch used checkout-HMAC, not webhook-secret HMAC.
  // Routes that exposed this are also gone (see `routes/transaction.js`).
  // The hardened, M11-aware gateway-specific controllers remain:
  //   `controllers/{stripe,razorpay,paypal}-webhook.js`.
  // Regression test: `scripts/test-generic-webhook-removed.js`.

  // Helper method to mark a transaction as failed
  async markTransactionFailed(gatewayTransactionId) {
    try {
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId }
      });

      if (transaction) {
        console.log(`Marking transaction ${transaction.id} as failed`);
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: 'failed'
          }
        });
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error marking transaction as failed:', error);
      return false;
    }
  },

  // Audit Wave-3 Vector D — `createPendingTransaction` handler removed.
  // The handler trusted client-supplied {amount, gateway, gatewayTransactionId}
  // (with only walletId scoped to the caller) and created a pending tx row
  // with those values verbatim — letting an attacker plant a $1000 pending
  // row that the M11 grace-period webhook would then credit on a real $1
  // gateway payment. Route at `routes/transaction.js` also removed.
  // Regression test: `scripts/test-pending-tx-route-removed.js`.

  // Get transaction status
  // Public payment-status check — used by the gateway redirect-back flow
  // (Razorpay / Stripe / PayPal land back at the SPA before the user's
  // session has finished hydrating; the SPA polls this endpoint with the
  // gateway-issued payment-intent ID to learn the outcome).
  //
  // SECURITY (pre-fix → post-fix):
  //   - Pre-fix accepted EITHER the gateway transaction id OR the internal
  //     numeric transaction id, with no auth. Anonymous attackers could
  //     iterate /transactions/status/<sequential-int> and harvest every
  //     transaction's type / amount / status + invoice id + invoice
  //     PDF URL. Confirmed exploitable on staging at id=85 → returned
  //     {"amount":100,"transactionStatus":"success",...}.
  //
  // Post-fix:
  //   - Only accept gateway-issued IDs. Gateway IDs are ≥ 14 chars of
  //     unguessable base62/hex (~80+ bits entropy: Razorpay pay_*, Stripe
  //     pi_*, PayPal PAYID-*). A purely numeric id is rejected outright —
  //     killing the enumeration vector. No `where: { id }` fallback.
  //   - Response is narrowed to { transactionStatus, gatewayTransactionId }
  //     so even a leaked gateway id cannot disclose amount / type /
  //     invoice URL.
  async getTransactionStatus(ctx) {
    try {
      const { id } = ctx.params;
      if (typeof id !== 'string' || id.length === 0) {
        return ctx.notFound('Transaction not found');
      }
      // Reject purely-numeric ids — that's the internal-id-IDOR path.
      // Gateway IDs always contain at least one non-digit character.
      if (/^\d+$/.test(id)) {
        return ctx.notFound('Transaction not found');
      }
      // Defensive: bound the length so a 50 MB body can't be passed via
      // path-param-smuggling proxies.
      if (id.length > 256) {
        return ctx.notFound('Transaction not found');
      }

      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: id },
        select: ['id', 'gatewayTransactionId', 'transactionStatus'],
      });

      if (transaction) {
        return {
          data: {
            transactionStatus: transaction.transactionStatus,
            gatewayTransactionId: transaction.gatewayTransactionId,
          },
        };
      }

      // Fall back to Stripe direct lookup only when the id looks like a
      // Stripe payment intent (`pi_*`). This prevents anonymous callers
      // from probing the Stripe account with arbitrary strings.
      if (/^pi_[a-zA-Z0-9_]+$/.test(id)) {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(id);
          return {
            data: {
              transactionStatus: paymentIntent.status === 'succeeded' ? 'success' :
                paymentIntent.status === 'processing' ? 'pending' : 'failed',
              gatewayTransactionId: id,
            },
          };
        } catch (stripeError) {
          strapi.log?.error?.('[transaction] stripe lookup failed', { error: stripeError.message });
          return ctx.notFound('Transaction not found');
        }
      }

      return ctx.notFound('Transaction not found');
    } catch (error) {
      strapi.log?.error?.('[transaction] getTransactionStatus failed', { error: error.message });
      return ctx.badRequest('Failed to get transaction status');
    }
  },

  // Audit C3 — Manual PayPal payment verification (server-authoritative).
  //
  // Pre-fix vulnerabilities (the previous handler trusted client-supplied
  // `walletId` and used `(orderId, walletId)` for its idempotency check):
  //   V1. Cross-user wallet credit — any authenticated attacker who knew a
  //       completed PayPal orderId (their own past payment, leaked invoice
  //       URL, etc.) could POST `{orderId, walletId:<attacker's wallet>}`
  //       and credit themselves using someone else's PayPal payment. The
  //       tuple-keyed idempotency didn't block re-binding the same orderId
  //       to a different wallet.
  //   V2. No M11 amount-mismatch cross-check — the credit amount came from
  //       PayPal's reported `purchase_units[0].amount.value`, with no
  //       comparison against the server-computed `expectedChargeCents`
  //       stashed in PayPal `custom_id` at order-creation time. This
  //       re-opened the M11 baseAmount vector for the manual verify path.
  //   V3. Wallet credited by PayPal's gross amount (includes fees/GST)
  //       rather than the server-derived `baseAmount` (the user's actual
  //       deposit intent). Inconsistent with the webhook path post-M11.
  //
  // Fix — model this on `paypal-webhook.handlePaymentCompleted`:
  //   - Ignore `walletId` from the request body entirely.
  //   - Parse `custom_id` from the PayPal order (server-set at create time).
  //   - Verify the order's bound wallet belongs to `ctx.state.user`.
  //   - M11 cross-check: actualCharge === expectedChargeCents.
  //   - Credit by `baseAmount`, not by PayPal's gross.
  //   - Idempotent on `gatewayTransactionId` across all wallets.
  async verifyPayPalPayment(ctx) {
    try {
      const userId = ctx.state.user?.id;
      if (!userId) return ctx.unauthorized();

      const { orderId } = ctx.request.body;
      if (!orderId) return ctx.badRequest('orderId is required');

      strapi.log.info(`[VERIFY-PAYPAL] userId=${userId} orderId=${orderId}`);

      // 1. Server-side fetch of PayPal order via OAuth.
      const orderDetails = await strapi.service('api::transaction.payment').getPayPalOrderDetails(orderId);
      if (!orderDetails.success) {
        return ctx.badRequest('Failed to get PayPal order details');
      }
      const order = orderDetails.order;

      if (order.status !== 'COMPLETED') {
        return ctx.badRequest('PayPal order is not completed');
      }

      const purchaseUnit = order.purchase_units?.[0];
      if (!purchaseUnit) {
        return ctx.badRequest('PayPal order is missing purchase unit');
      }

      // 2. Parse server-set custom_id. createPayment writes
      // {walletId, userId, baseAmount, expectedChargeCents} as JSON.
      let customWalletId = null;
      let baseAmount = null;
      let expectedChargeCents = null;
      try {
        const customData = JSON.parse(purchaseUnit.custom_id || '{}');
        customWalletId = customData.walletId != null ? parseInt(customData.walletId, 10) : null;
        baseAmount = customData.baseAmount != null ? parseFloat(customData.baseAmount) : null;
        expectedChargeCents = customData.expectedChargeCents != null ? Number(customData.expectedChargeCents) : null;
      } catch (_) {
        // Legacy custom_id is a bare wallet id; treat as missing M11 metadata.
        const n = purchaseUnit.custom_id ? parseInt(purchaseUnit.custom_id, 10) : NaN;
        if (Number.isFinite(n)) customWalletId = n;
      }

      if (!customWalletId) {
        strapi.log.error(`[VERIFY-PAYPAL] orderId=${orderId} missing wallet binding in custom_id — REFUSING`);
        return ctx.badRequest('Order metadata is incomplete');
      }

      // 3. Ownership: the wallet bound to this PayPal order must belong to
      // the caller. Body-supplied walletId is intentionally ignored.
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: customWalletId },
        populate: ['users_permissions_user'],
      });
      if (!wallet) return ctx.badRequest('Wallet not found');
      if (wallet.users_permissions_user?.id !== userId) {
        strapi.log.error(
          `[VERIFY-PAYPAL] cross-user attempt — orderId=${orderId} ` +
          `walletOwner=${wallet.users_permissions_user?.id} caller=${userId}`
        );
        return ctx.forbidden('You do not own this PayPal order');
      }

      // 4. Idempotency — keyed on orderId across ALL wallets so the same
      // PayPal order cannot be re-credited to a different wallet.
      const existingSuccess = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId: orderId, gateway: 'paypal', transactionStatus: 'success' },
      });
      if (existingSuccess) {
        return ctx.send({
          success: true,
          message: 'Transaction already processed',
          transaction: existingSuccess,
        });
      }

      // 5. M11 amount-mismatch cross-check.
      const paypalChargeAmount = parseFloat(purchaseUnit.amount?.value || '0');
      const actualChargeCents = Math.round(paypalChargeAmount * 100);
      const GRACE_PERIOD_END = new Date('2026-07-16T00:00:00Z');
      if (Number.isFinite(expectedChargeCents) && expectedChargeCents > 0) {
        if (actualChargeCents !== expectedChargeCents) {
          strapi.log.error(
            `[VERIFY-PAYPAL] amount mismatch — REFUSING. ` +
            `actual=${actualChargeCents}c expected=${expectedChargeCents}c orderId=${orderId}`
          );
          // Audit row for the failed attempt.
          await strapi.entityService.create('api::transaction.transaction', {
            data: {
              type: 'deposit',
              amount: 0,
              netAmount: 0,
              transactionStatus: 'failed',
              gateway: 'paypal',
              gatewayTransactionId: orderId,
              description: `PayPal amount mismatch (manual verify) - Order ${orderId}`,
              user_wallet: wallet.id,
              users_permissions_user: userId,
              fund_source: 'main_fund',
              metadata: {
                error: 'amount_mismatch',
                actualChargeCents,
                expectedChargeCents,
                orderId,
                manualVerification: true,
                processedAt: new Date().toISOString(),
              },
              publishedAt: new Date(),
            },
          });
          return ctx.badRequest('Payment amount does not match expected charge');
        }
      } else if (new Date() > GRACE_PERIOD_END) {
        strapi.log.error(`[VERIFY-PAYPAL] missing expectedChargeCents post-grace — REFUSING. orderId=${orderId}`);
        return ctx.badRequest('Order metadata is incomplete');
      } else {
        strapi.log.warn(`[VERIFY-PAYPAL] legacy order missing expectedChargeCents (grace period). orderId=${orderId}`);
      }

      // 6. Credit the wallet by server-derived baseAmount (excludes fees/GST).
      // Fallback to PayPal's gross only for the grace-period legacy branch above.
      const amountToCredit = baseAmount !== null && baseAmount > 0 ? baseAmount : paypalChargeAmount;

      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      const newMainBalance = currentMainBalance + amountToCredit;
      const newTotalBalance = newMainBalance + currentPromoBalance;

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: wallet.id },
        data: { mainBalance: newMainBalance, balance: newTotalBalance },
      });

      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amountToCredit,
          netAmount: amountToCredit,
          transactionStatus: 'success',
          gateway: 'paypal',
          gatewayTransactionId: orderId,
          description: `PayPal payment - Manual verification`,
          user_wallet: wallet.id,
          users_permissions_user: userId,
          fund_source: 'main_fund',
          fee: 0,
          metadata: {
            orderId,
            manualVerification: true,
            baseAmount,
            expectedChargeCents,
            paypalCharge: paypalChargeAmount,
          },
          publishedAt: new Date(),
        },
      });

      strapi.log.info(`[VERIFY-PAYPAL] ✅ orderId=${orderId} wallet=${wallet.id} credited $${amountToCredit}`);

      // Real-time push so the wallet UI sees the deposit instantly.
      try {
        await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
          userId,
          'paypal_verify',
          { orderId, walletId: wallet.id, amount: amountToCredit, transactionId: transaction.id }
        );
      } catch (emitErr) {
        strapi.log.warn(`[VERIFY-PAYPAL] emitBalanceUpdate failed (non-fatal): ${emitErr.message}`);
      }

      // Fire-and-forget invoice creation via the centralized service. This
      // verify path is the client-side callback from PayPal's checkout and
      // is what credits most production deposits — must invoice here too,
      // not only via the PAYMENT.CAPTURE.COMPLETED webhook. Idempotent on
      // transactionId so a webhook + verify double-fire dedupes.
      strapi.service('api::invoice.invoice')
        .createInvoiceForTransaction(transaction, wallet.users_permissions_user)
        .catch((invErr) => strapi.log.warn(`[VERIFY-PAYPAL] invoice creation failed (non-fatal): ${invErr.message}`));

      // Affiliate commission — idempotent by design.
      strapi.service('api::affiliate-commission.affiliate-commission')
        .awardOnDeposit({ depositTransactionId: transaction.id })
        .catch((e) => strapi.log.warn(`[VERIFY-PAYPAL] awardOnDeposit failed (non-fatal): ${e.message}`));

      return ctx.send({
        success: true,
        message: 'Payment verified and wallet updated',
        transaction,
        newBalance: newTotalBalance,
      });
    } catch (error) {
      strapi.log.error('[VERIFY-PAYPAL] error:', error);
      return ctx.internalServerError('Failed to verify PayPal payment');
    }
  },

  // Approve transaction via email (Admin only)
  async approveTransaction(ctx) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if user is admin or has special access
      const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');

      if (!isAdmin) {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;

      const transaction = await strapi.entityService.findOne('api::transaction.transaction', id, {
        populate: ['users_permissions_user']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      // Update transaction status
      const updatedTransaction = await strapi.entityService.update('api::transaction.transaction', id, {
        data: {
          transactionStatus: 'success',
          approvedAt: new Date(),
          approvedBy: user.id
        }
      });

      // Send approval email
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendTransactionApprovalEmail(
          updatedTransaction,
          transaction.users_permissions_user.email
        );
        console.log(`Transaction approval email sent for transaction ${id}`);
      } catch (emailError) {
        console.error('Failed to send transaction approval email:', emailError);
        // Don't fail the approval if email fails
      }

      return {
        data: updatedTransaction,
        meta: {
          message: 'Transaction approved successfully and email sent'
        }
      };
    } catch (error) {
      console.error('Error approving transaction:', error);
      return ctx.internalServerError('An error occurred while approving the transaction');
    }
  },

  // Deny transaction via email (Admin only)
  async denyTransaction(ctx) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if user is admin or has special access
      const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');

      if (!isAdmin) {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      if (!reason || reason.trim().length === 0) {
        return ctx.badRequest('Denial reason is required');
      }

      const transaction = await strapi.entityService.findOne('api::transaction.transaction', id, {
        populate: ['users_permissions_user']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      // Update transaction status
      const updatedTransaction = await strapi.entityService.update('api::transaction.transaction', id, {
        data: {
          transactionStatus: 'denied',
          deniedAt: new Date(),
          deniedBy: user.id,
          denialReason: reason.trim()
        }
      });

      // Send denial email
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendTransactionDenialEmail(
          updatedTransaction,
          transaction.users_permissions_user.email,
          reason.trim()
        );
        console.log(`Transaction denial email sent for transaction ${id}`);
      } catch (emailError) {
        console.error('Failed to send transaction denial email:', emailError);
        // Don't fail the denial if email fails
      }

      return {
        data: updatedTransaction,
        meta: {
          message: 'Transaction denied successfully and email sent'
        }
      };
    } catch (error) {
      console.error('Error denying transaction:', error);
      return ctx.internalServerError('An error occurred while denying the transaction');
    }
  },

  // Mark transaction as paid via email (Admin only)
  async markTransactionPaid(ctx) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if user is admin or has special access
      const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');

      if (!isAdmin) {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;

      const transaction = await strapi.entityService.findOne('api::transaction.transaction', id, {
        populate: ['users_permissions_user']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      // Update transaction status
      const updatedTransaction = await strapi.entityService.update('api::transaction.transaction', id, {
        data: {
          transactionStatus: 'paid',
          paidAt: new Date(),
          markedPaidBy: user.id
        }
      });

      // Send payment confirmation email
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendPaymentConfirmationEmail(
          updatedTransaction,
          transaction.users_permissions_user.email
        );
        console.log(`Payment confirmation email sent for transaction ${id}`);
      } catch (emailError) {
        console.error('Failed to send payment confirmation email:', emailError);
        // Don't fail the operation if email fails
      }

      return {
        data: updatedTransaction,
        meta: {
          message: 'Transaction marked as paid successfully and email sent'
        }
      };
    } catch (error) {
      console.error('Error marking transaction as paid:', error);
      return ctx.internalServerError('An error occurred while marking the transaction as paid');
    }
  }
}));
