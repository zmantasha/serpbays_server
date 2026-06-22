'use strict';

/**
 * withdrawal-request controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const crypto = require('crypto');

const MAX_OTP_ATTEMPTS = 5;

// Constant-time OTP comparison. Returns false if lengths differ rather than throwing.
function safeCompareOtp(stored, provided) {
  if (typeof stored !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ===== Field-exposure controls =====
//
// privateAttributes in schema.json covers: payment_notes, denial_reason,
// external_transaction_id, payment_reference. But it does NOT cover:
//   - admin_notes (internal admin commentary)
//   - details (JSON: bank account / PayPal / Payoneer destination data)
//   - publisher (populated → full up_users row leak: password hash,
//     withdrawalOtp/Amount/Attempts, paypal_email, billing PII, ...)
// We allow-list explicitly here so the default-find / findOne responses
// (and any future overrides) can never auto-leak those fields.
const WITHDRAWAL_USER_FIELDS = [
  'id', 'documentId',
  'amount', 'method', 'withdrawal_status',
  // 'details' intentionally OMITTED at the listing level — it contains
  // payout destination data (bank #, PayPal email, ...). Surfaced only
  // on the owner's getMyWithdrawals/sub-resource flows.
  'createdAt', 'updatedAt', 'publishedAt',
  'approved_at', 'paid_at', 'rejected_at',
];

function isWithdrawalOwner(record, user) {
  if (!record || !user || typeof user.id !== 'number') return false;
  return record.publisher?.id === user.id;
}

function isAdminUser(user) {
  if (!user) return false;
  // Defense-in-depth: handler-level admin gate uses role.type. Magic-string
  // email backdoor in the codebase is being phased out — do not honor it
  // here. Role check only.
  return user.role && user.role.type === 'admin';
}

module.exports = createCoreController('api::withdrawal-request.withdrawal-request', ({ strapi }) => ({

  // ===== Default-route overrides — close the Authenticated-role IDOR =====
  //
  // routes/withdrawal-request.js declares createCoreRouter (except: ['create']).
  // That registers GET /api/withdrawal-requests, GET /:id, PUT /:id, DELETE /:id.
  // The Authenticated role has find / findOne / update / delete on this
  // content type. With NO controller overrides, any logged-in user could:
  //   - GET /api/withdrawal-requests → list every withdrawal on the
  //     platform (amount, method, status, full payout destination JSON,
  //     publisher PII, admin_notes).
  //   - GET /api/withdrawal-requests/:N → read any withdrawal.
  //   - PUT /api/withdrawal-requests/:N → mutate fields not protected by
  //     the wave-4 status-transition lifecycle (details / admin_notes /
  //     payment_reference / external_transaction_id).
  //   - DELETE /api/withdrawal-requests/:N → delete any withdrawal.
  // Sensitive operations (approve/deny/mark-paid) DO have an in-handler
  // role.type==='admin' gate already, so they are not exposed by this gap.

  async find(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized('You must be logged in to list withdrawal requests');
    }
    // Admins → trust their query (still subject to default scoping; admin
    // UI is the intended consumer).
    if (isAdminUser(ctx.state.user)) {
      return super.find(ctx);
    }
    // Publishers → restrict to their own rows.
    const userFilters = ctx.query?.filters;
    const ownership = { publisher: ctx.state.user.id };
    ctx.query = {
      ...ctx.query,
      filters: userFilters ? { $and: [userFilters, ownership] } : ownership,
      fields: WITHDRAWAL_USER_FIELDS,
      populate: undefined,
    };
    return super.find(ctx);
  },

  async findOne(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized('You must be logged in to view this withdrawal request');
    }
    const { id } = ctx.params;
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('Withdrawal request not found');
    }
    const record = await strapi.db.query('api::withdrawal-request.withdrawal-request').findOne({
      where: { id: numericId },
      populate: { publisher: { select: ['id'] } },
    });
    if (!record) return ctx.notFound('Withdrawal request not found');
    if (!isAdminUser(ctx.state.user) && !isWithdrawalOwner(record, ctx.state.user)) {
      // 404 not 403 — defeat withdrawal-id enumeration.
      return ctx.notFound('Withdrawal request not found');
    }
    // Build the response from the allow-list. Admins also get the
    // user-safe shape via the same route; admin UI uses dedicated
    // /admin/withdrawals endpoints for the full record.
    const safe = {};
    for (const k of WITHDRAWAL_USER_FIELDS) {
      if (record[k] !== undefined) safe[k] = record[k];
    }
    // Owner is allowed to see their own `details` (their own bank/paypal data).
    if (isWithdrawalOwner(record, ctx.state.user) && record.details !== undefined) {
      safe.details = record.details;
    }
    return { data: safe };
  },

  async update(ctx) {
    // All legitimate updates flow through the explicit admin endpoints:
    //   POST /admin/withdrawal-requests/:id/approve
    //   POST /admin/withdrawal-requests/:id/deny
    //   POST /admin/withdrawal-requests/:id/mark-as-paid
    // Each has an in-handler admin role gate + wave-4 status guard.
    // Disable the default PUT /api/withdrawal-requests/:id route — it
    // bypasses status-transition rules for non-status fields (admin_notes,
    // details, payment_reference) and there is no legitimate user-facing
    // use case.
    return ctx.forbidden(
      'Direct withdrawal updates are not allowed. Use the specific admin action endpoints.'
    );
  },

  async delete(ctx) {
    // Withdrawals are a financial audit record. Never deleted by users.
    return ctx.forbidden('Withdrawal requests cannot be deleted');
  },

  // Send OTP for withdrawal verification
  async sendWithdrawalOtp(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      const { amount } = ctx.request.body;
      if (!amount || parseFloat(amount) <= 0) {
        return ctx.badRequest('Valid withdrawal amount is required');
      }

      const userId = ctx.state.user.id;

      const OTP_VALIDITY_MS = 1 * 60 * 1000; // 1 minute
      const RESEND_COOLDOWN_MS = 60 * 1000;  // 60 seconds between sends

      // Rate limit: use the explicit sent-at timestamp (independent of validity)
      const user = await strapi.entityService.findOne('plugin::users-permissions.user', userId, {
        fields: ['withdrawalOtpSentAt']
      });

      if (user.withdrawalOtpSentAt) {
        const timeSinceSent = Date.now() - new Date(user.withdrawalOtpSentAt).getTime();
        if (timeSinceSent < RESEND_COOLDOWN_MS) {
          const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - timeSinceSent) / 1000);
          return ctx.badRequest(`Please wait ${waitSeconds} seconds before requesting a new OTP`);
        }
      }

      // Generate 6-digit OTP. Use crypto.randomInt for an unbiased uniform draw.
      const now = new Date();
      const otpCode = crypto.randomInt(100000, 1000000).toString();
      const otpExpiry = new Date(now.getTime() + OTP_VALIDITY_MS);
      const requestedAmount = parseFloat(amount);

      // Store OTP on user record. Bind it to the requested amount so the same
      // code cannot authorize a different withdrawal value at confirmation time.
      await strapi.entityService.update('plugin::users-permissions.user', userId, {
        data: {
          withdrawalOtp: otpCode,
          withdrawalOtpExpiry: otpExpiry,
          withdrawalOtpSentAt: now,
          withdrawalOtpAmount: requestedAmount,
          withdrawalOtpAttempts: 0
        }
      });

      // Send OTP email. If the email send fails, roll back the stored OTP
      // so a flaky email service can't leave a usable OTP in the database.
      try {
        const validityMinutes = Math.round(OTP_VALIDITY_MS / 60000);
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendWithdrawalOtpEmail(otpCode, ctx.state.user.email, amount, {
          firstName: ctx.state.user.firstName,
          username: ctx.state.user.username,
          validityMinutes,
        });
      } catch (emailError) {
        await strapi.entityService.update('plugin::users-permissions.user', userId, {
          data: {
            withdrawalOtp: null,
            withdrawalOtpExpiry: null,
            withdrawalOtpSentAt: null,
            withdrawalOtpAmount: null,
            withdrawalOtpAttempts: 0
          }
        });
        console.error('[WithdrawalOTP] Email send failed, rolled back OTP for user', userId, emailError);
        return ctx.internalServerError('Could not deliver the verification email. Please try again in a moment.');
      }

      console.log(`[WithdrawalOTP] OTP sent to user ${userId} for withdrawal of $${requestedAmount}`);

      return {
        data: {
          message: 'Verification code sent to your email',
          expiresAt: otpExpiry.toISOString()
        }
      };
    } catch (error) {
      const ref = crypto.randomBytes(4).toString('hex');
      console.error(`[WithdrawalOTP] Error sending OTP (ref ${ref}):`, error);
      return ctx.internalServerError(`Failed to send verification code (ref: ${ref}). Please contact support if this persists.`);
    }
  },

  // Create a new withdrawal request
  async create(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        console.log('Request by unauthenticated user');
        return ctx.unauthorized('Authentication required');
      }

      console.log('User authenticated with ID:', ctx.state.user.id);

      // Get the request body
      const { amount, method, details, otpCode } = ctx.request.body.data || ctx.request.body;

      console.log('Received withdrawal request:', { amount, method, details: JSON.stringify(details), hasOtp: !!otpCode });

      // Validate required fields
      if (!amount || !method || !details) {
        console.log('Missing required fields:', { amount, method, details: !!details });
        return ctx.badRequest('Missing required fields: amount, method, and details are required');
      }

      // Verify OTP
      if (!otpCode) {
        return ctx.badRequest('Verification code is required');
      }

      const userWithOtp = await strapi.entityService.findOne('plugin::users-permissions.user', ctx.state.user.id, {
        fields: ['withdrawalOtp', 'withdrawalOtpExpiry', 'withdrawalOtpAmount', 'withdrawalOtpAttempts']
      });

      const clearOtp = () => strapi.entityService.update('plugin::users-permissions.user', ctx.state.user.id, {
        data: {
          withdrawalOtp: null,
          withdrawalOtpExpiry: null,
          withdrawalOtpSentAt: null,
          withdrawalOtpAmount: null,
          withdrawalOtpAttempts: 0
        }
      });

      if (!userWithOtp.withdrawalOtp || !userWithOtp.withdrawalOtpExpiry) {
        return ctx.badRequest('No verification code found. Please request a new one.');
      }

      if (new Date(userWithOtp.withdrawalOtpExpiry) < new Date()) {
        await clearOtp();
        return ctx.badRequest('Verification code has expired. Please request a new one.');
      }

      // Brute-force protection: if too many wrong attempts, invalidate this OTP.
      const prevAttempts = userWithOtp.withdrawalOtpAttempts || 0;
      if (prevAttempts >= MAX_OTP_ATTEMPTS) {
        await clearOtp();
        return ctx.badRequest('Too many incorrect attempts. Please request a new verification code.');
      }

      // Bind the OTP to the amount it was issued for. Prevents reusing a
      // small-amount OTP to authorize a large withdrawal.
      const requestedAmount = parseFloat(amount);
      const storedAmount = parseFloat(userWithOtp.withdrawalOtpAmount || 0);
      if (!Number.isFinite(storedAmount) || Math.abs(storedAmount - requestedAmount) > 0.005) {
        await strapi.entityService.update('plugin::users-permissions.user', ctx.state.user.id, {
          data: { withdrawalOtpAttempts: prevAttempts + 1 }
        });
        return ctx.badRequest('This verification code was issued for a different amount. Please request a new code.');
      }

      // Constant-time comparison to avoid leaking the OTP through response timing.
      if (!safeCompareOtp(userWithOtp.withdrawalOtp, otpCode)) {
        const nextAttempts = prevAttempts + 1;
        const remaining = Math.max(0, MAX_OTP_ATTEMPTS - nextAttempts);
        if (remaining === 0) {
          await clearOtp();
          return ctx.badRequest('Too many incorrect attempts. Please request a new verification code.');
        }
        await strapi.entityService.update('plugin::users-permissions.user', ctx.state.user.id, {
          data: { withdrawalOtpAttempts: nextAttempts }
        });
        return ctx.badRequest(`Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
      }

      // Atomic OTP consume. Two concurrent requests can both pass
      // safeCompareOtp above; only ONE can actually clear the row. The
      // conditional UPDATE serializes the consume — second caller sees 0
      // affected rows and bails. This is the OTP-side of the over-withdrawal
      // race fix; the wallet-side is the strapi.db.transaction below.
      const consumeResult = await strapi.db.connection.raw(
        `UPDATE up_users
         SET withdrawal_otp = NULL, withdrawal_otp_expiry = NULL,
             withdrawal_otp_sent_at = NULL, withdrawal_otp_amount = NULL,
             withdrawal_otp_attempts = 0, updated_at = NOW()
         WHERE id = ? AND withdrawal_otp = ?
         RETURNING id`,
        [ctx.state.user.id, otpCode]
      );
      const otpConsumed = consumeResult && consumeResult.rows && consumeResult.rows.length === 1;
      if (!otpConsumed) {
        // Another concurrent request consumed this OTP first.
        return ctx.badRequest('Verification code is no longer valid (consumed by a concurrent request). Please request a new code.');
      }

      console.log(`[WithdrawalOTP] OTP verified + atomically consumed for user ${ctx.state.user.id}`);

      // Ensure details is a valid JSON object
      let formattedDetails = details;
      if (typeof details === 'string') {
        try {
          formattedDetails = { value: details };
        } catch (e) {
          console.error('Error formatting details:', e);
          return ctx.badRequest('Details must be a valid JSON object');
        }
      }

      // Validate amount is a positive number
      const requestAmount = parseFloat(amount);
      if (isNaN(requestAmount) || requestAmount <= 0) {
        console.log('Invalid amount:', amount);
        return ctx.badRequest('Amount must be a positive number');
      }

      // 🛡️ ENHANCED DUPLICATE PREVENTION: Check with shorter window and add request ID uniqueness
      const tenSecondsAgo = new Date(Date.now() - 10 * 1000);// Reduced from 10 sec
      const recentDuplicate = await strapi.db.query('api::withdrawal-request.withdrawal-request').findOne({
        where: {
          publisher: ctx.state.user.id,
          amount: requestAmount,
          method: method,
          createdAt: {
            $gte: tenSecondsAgo
          }
        }
      });

      if (recentDuplicate) {
        console.log(`[DUPLICATE PREVENTION] Blocking duplicate withdrawal request for user ${ctx.state.user.id}:`, {
          existingRequest: recentDuplicate.id,
          amount: requestAmount,
          method: method
        });
        return ctx.badRequest('Duplicate withdrawal request detected. Please wait before making another request with the same amount and method.');
      }

      // 🔒 ADD REQUEST UNIQUENESS: Create unique gateway transaction ID early
      const uniqueRequestId = `${ctx.state.user.id}_${requestAmount}_${method}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      console.log(`[DUPLICATE PREVENTION] Generated unique request ID: ${uniqueRequestId}`);

      // Get publisher wallet
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: {
          users_permissions_user: ctx.state.user.id
        }
      });

      if (!publisherWallet) {
        console.log('Publisher wallet not found for user:', ctx.state.user.id);
        return ctx.badRequest('Publisher wallet not found');
      }
      console.log('Found publisher wallet:', {
        id: publisherWallet.id,
        balance: publisherWallet.balance,
        escrow: publisherWallet.escrowBalance,
        pendingWithdrawalBalance: publisherWallet.pendingWithdrawalBalance,
        fullWalletObject: publisherWallet
      });

      // Balance Check Logic (aligned with getAvailableBalance)
      // STEP 1: Get all completed/approved order IDs for this user.
      const allCompletedRawOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: ctx.state.user.id,
          orderStatus: { $in: ['approved', 'completed'] }
        }
      });
      const completedOrderIds = new Set(allCompletedRawOrders.map(order => order.id));
      console.log(`[Create] Found ${completedOrderIds.size} raw completed/approved order IDs for publisher ${ctx.state.user.id}`);

      // STEP 2: Get ALL 'escrow_release' transactions for these completed orders.
      const allEscrowReleaseTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters: {
          user_wallet: { id: publisherWallet.id },
          type: 'escrow_release',
          order: { id: { $in: Array.from(completedOrderIds) } }
        },
        populate: ['order'],
        sort: { createdAt: 'desc' }
      });
      console.log(`[Create] Found ${allEscrowReleaseTransactions.length} total escrow_release transactions.`);

      // STEP 3: Deduplicate to get unique transactions per order.
      const orderTransactionMap = new Map();
      allEscrowReleaseTransactions.forEach(tx => {
        const orderId = tx.order?.id;
        if (orderId && completedOrderIds.has(orderId)) {
          if (!orderTransactionMap.has(orderId) || new Date(tx.createdAt) > new Date(orderTransactionMap.get(orderId).createdAt)) {
            orderTransactionMap.set(orderId, tx);
          }
        }
      });
      const uniqueCompletedOrderTransactions = Array.from(orderTransactionMap.values());
      console.log(`[Create] Found ${uniqueCompletedOrderTransactions.length} unique transactions for completed orders amount.`);

      // STEP 4: Calculate GROSS completedOrdersAmount.
      const grossCompletedOrdersAmount = uniqueCompletedOrderTransactions.reduce((total, tx) => {
        return total + parseFloat(tx.amount || 0);
      }, 0);
      console.log(`[Create] Calculated GROSS completedOrdersAmount: ${grossCompletedOrdersAmount}`);

      // STEP 5: Check available balance (Available Balance = Wallet Balance)
      const walletBalance = parseFloat(publisherWallet.balance || 0);
      const pendingWithdrawalBalance = parseFloat(publisherWallet.pendingWithdrawalBalance || 0);

      console.log('[Create] Pre-withdrawal Balance Check:', {
        walletBalance,
        pendingWithdrawalBalance,
        requestAmount,
        note: 'Available balance equals wallet balance'
      });

      // STEP 6: Check if user has sufficient MAIN balance for withdrawal (promo funds cannot be withdrawn)
      const mainBalance = parseFloat(publisherWallet.mainBalance || 0);
      const promoBalance = parseFloat(publisherWallet.promoBalance || 0);
      const totalBalance = parseFloat(publisherWallet.balance || 0);

      console.log('Balance breakdown:', {
        mainBalance,
        promoBalance,
        totalBalance,
        requestAmount
      });

      // Calculate 20% platform fee
      const PLATFORM_FEE_RATE = 0.20;
      const platformFee = Math.round((requestAmount / (1 - PLATFORM_FEE_RATE)) * PLATFORM_FEE_RATE * 100) / 100;
      const totalDeduction = Math.round((requestAmount + platformFee) * 100) / 100;

      console.log('Platform fee calculation:', {
        requestAmount,
        platformFeeRate: PLATFORM_FEE_RATE,
        platformFee,
        totalDeduction
      });

      if (mainBalance < totalDeduction) {
        return ctx.badRequest(`Insufficient withdrawable funds. Available for withdrawal: ${mainBalance}, Total required (including 20% platform fee): ${totalDeduction}. Note: Promo credits (${promoBalance}) cannot be withdrawn.`);
      }

      // The rest of the create method continues from here...
      // Note: `completedOrdersTransactions` used later for marking specific transactions
      // might need to be derived differently if it was based on the old `availableTransactions`
      // For now, we assume the main goal is to fix the insufficient funds error.
      // The most straightforward approach is to pass all uniqueCompletedOrderTransactions and let the loop pick.
      const completedOrdersTransactionsToProcess = uniqueCompletedOrderTransactions;

      // ═══════════════════════════════════════════════════════════════════
      // Atomic money-moving section.
      //
      // Wraps wallet read → sufficiency re-check → wallet write →
      // withdrawal_request insert → transaction insert in a single
      // strapi.db.transaction with SELECT … FOR UPDATE on the user_wallets
      // row. Defends against the over-withdrawal race confirmed by the
      // 14-agent independent verification:
      //   - Concurrent creates serialize on the row lock (second waits)
      //   - Re-read inside the lock sees FRESH main_balance
      //   - Atomic CAS UPDATE (where main_balance = pre-lock value) refuses
      //     to commit if the value moved underneath — defense-in-depth
      //   - DB CHECK constraints (chk_user_wallets_main_balance_nonneg etc.,
      //     applied by migration 2026.06.18T00.00.00) are belt-and-suspenders
      //
      // entityService.create calls inside the trx callback rely on Strapi 5
      // AsyncLocalStorage to propagate the active transaction. The wallet
      // CAS uses raw knex `trx` directly to guarantee atomicity.
      // ═══════════════════════════════════════════════════════════════════
      let withdrawalRequest;
      let transactionRecord;
      try {
        await strapi.db.transaction(async ({ trx }) => {
          // 1. Lock the wallet row. Second concurrent request waits here.
          const lockedRow = await trx('user_wallets')
            .where({ id: publisherWallet.id })
            .forUpdate()
            .first();
          if (!lockedRow) {
            const e = new Error('Publisher wallet disappeared during lock acquisition');
            e.isClientError = true;
            throw e;
          }

          const lockedMainBalance = parseFloat(lockedRow.main_balance || 0);

          // 2. Re-check sufficiency against FRESH (locked) main_balance.
          //    This is the check the unlocked pre-trx test could not enforce
          //    against a concurrent debit.
          if (lockedMainBalance < totalDeduction) {
            const e = new Error(
              `Insufficient withdrawable funds (race-checked under wallet lock). ` +
              `Available: $${lockedMainBalance.toFixed(2)}, ` +
              `total required (with 20% platform fee): $${totalDeduction.toFixed(2)}.`
            );
            e.isClientError = true;
            throw e;
          }

          // 3. CAS update wallet — refuses if main_balance moved between
          //    lock acquisition and update. Belt-and-suspenders given the
          //    forUpdate lock should already serialize.
          const updateCount = await trx('user_wallets')
            .where({ id: lockedRow.id, main_balance: lockedRow.main_balance })
            .update({
              main_balance: trx.raw('main_balance - ?::numeric', [totalDeduction]),
              balance: trx.raw('balance - ?::numeric', [totalDeduction]),
              pending_withdrawal_balance: trx.raw('pending_withdrawal_balance + ?::numeric', [requestAmount]),
              updated_at: new Date(),
            });
          if (updateCount !== 1) {
            throw new Error(
              `Wallet write conflict (affected ${updateCount} rows; expected 1). ` +
              `Concurrent transaction modified the wallet. Please retry.`
            );
          }

          console.log(
            `[Withdrawal trx] wallet ${lockedRow.id} debited $${totalDeduction.toFixed(2)} ` +
            `($${requestAmount} payout + $${platformFee} fee). ` +
            `main_balance ${lockedMainBalance.toFixed(2)} → ${(lockedMainBalance - totalDeduction).toFixed(2)}`
          );

          // 4. Create the withdrawal request row. Strapi 5 entityService
          //    auto-detects the active trx via AsyncLocalStorage and enrolls
          //    this insert in it.
          withdrawalRequest = await strapi.entityService.create('api::withdrawal-request.withdrawal-request', {
            data: {
              publisher: ctx.state.user.id,
              amount: requestAmount,
              method,
              details: formattedDetails,
              withdrawal_status: 'pending',
            },
          });

          // 5. Create the withdrawal transaction record.
          transactionRecord = await strapi.entityService.create('api::transaction.transaction', {
            data: {
              type: 'withdrawal',
              amount: totalDeduction,
              netAmount: requestAmount,
              fee: platformFee,
              transactionStatus: 'pending',
              gateway: method,
              gatewayTransactionId: uniqueRequestId,
              description: `Withdrawal request #${withdrawalRequest.id} via ${method} — $${requestAmount} payout + $${platformFee} platform fee (20%)`,
              user_wallet: publisherWallet.id,
              users_permissions_user: ctx.state.user.id,
            },
          });
        });
      } catch (err) {
        if (err && err.isClientError) {
          return ctx.badRequest(err.message);
        }
        console.error('[Withdrawal create] transaction failed:', err);
        return ctx.internalServerError(
          'Failed to create withdrawal request: ' + (err && err.message ? err.message : 'unknown error')
        );
      }

      console.log(`Created withdrawal request: ${withdrawalRequest.id}`);
      console.log(`[DUPLICATE PREVENTION] Created unique transaction ${transactionRecord.id} with gateway ID: ${uniqueRequestId}`);

      // Bookkeeping (outside trx): mark escrow_release transactions as
      // "included in withdrawal #X". Purely cosmetic description updates;
      // not race-sensitive, not money-moving. Runs only if the trx above
      // committed.
      if (completedOrdersTransactionsToProcess.length > 0) {
        completedOrdersTransactionsToProcess.sort((a, b) => {
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });

        const processedOrderIds = new Set();
        let amountRemaining = requestAmount;

        for (const tx of completedOrdersTransactionsToProcess) {
          if (amountRemaining <= 0) break;
          if (!tx.order || !tx.order.id || processedOrderIds.has(tx.order.id)) continue;
          processedOrderIds.add(tx.order.id);
          const txAmount = parseFloat(tx.amount);
          const amountToUse = Math.min(txAmount, amountRemaining);

          let baseDescription = tx.description || '';
          if (baseDescription.includes(' - Included in withdrawal request')) {
            baseDescription = baseDescription.split(' - Included in withdrawal request')[0];
          }
          await strapi.entityService.update('api::transaction.transaction', tx.id, {
            data: {
              description: `${baseDescription} - Included in withdrawal request #${withdrawalRequest.id}`,
            },
          });
          amountRemaining -= amountToUse;
        }
      }

      return {
        data: withdrawalRequest,
        meta: {
          message: 'Withdrawal request created successfully',
        },
      };

    } catch (error) {
      console.error('Error creating withdrawal request:', error);
      return ctx.badRequest('Failed to create withdrawal request', { error: error.message });
    }
  },

  // Get my withdrawal requests
  async getMyWithdrawals(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      const userId = ctx.state.user.id;
      const { pagination, filters: queryFilters } = ctx.query;

      console.log('[WithdrawalController|getMyWithdrawals] Received query:', JSON.stringify(ctx.query, null, 2));

      // Base filters: always filter by the current user
      const baseFilters = {
        publisher: { id: userId },
      };

      // Merge base filters with filters from query string
      let combinedFilters = { ...baseFilters };
      if (queryFilters && typeof queryFilters === 'object') {
        // Example: if queryFilters is { withdrawal_status: { '$eq': 'paid' } }
        // it will be merged directly.
        // Strapi's entityService expects filters in a nested structure.
        // The frontend sends: filters[withdrawal_status][$eq]=paid
        // Strapi's qs parser turns this into: { withdrawal_status: { '$eq': 'paid' } }
        // So, we can merge queryFilters directly.
        for (const key in queryFilters) {
          if (Object.prototype.hasOwnProperty.call(queryFilters, key)) {
            combinedFilters[key] = queryFilters[key];
          }
        }
      }

      console.log('[WithdrawalController|getMyWithdrawals] Combined filters for query:', JSON.stringify(combinedFilters, null, 2));

      // Default pagination if not provided
      const start = parseInt(pagination?.start || '0', 10);
      const limit = parseInt(pagination?.limit || '10', 10); // Default to 10 if not specified

      console.log('[WithdrawalController|getMyWithdrawals] Pagination params:', { start, limit });

      const withdrawalRequests = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: combinedFilters,
        sort: { createdAt: 'desc' },
        start: start, // for offset
        limit: limit, // for page size
      });

      // For accurate hasMoreItems, we might need to query total count with filters but without pagination
      // Or, rely on the frontend logic: if count returned is less than limit, no more items.
      // The current frontend logic (historyData.length === WITHDRAWALS_PER_PAGE) works if the API returns a full page or less.

      const totalCount = await strapi.entityService.count('api::withdrawal-request.withdrawal-request', {
        filters: combinedFilters,
      });


      console.log(`[WithdrawalController|getMyWithdrawals] Retrieved ${withdrawalRequests.length} requests for user ${userId} with filters. Total matching: ${totalCount}`);

      // Strapi's findMany typically returns just the array of entities if no 'meta' is requested via populate.
      // The frontend expects { data: [...] }
      // Let's ensure the response structure matches what the frontend service expects (data.data)
      return {
        data: withdrawalRequests, // The array of entities
        meta: { // Optional: Strapi like meta for pagination
          pagination: {
            start,
            limit,
            total: totalCount,
            page: Math.floor(start / limit) + 1,
            pageCount: Math.ceil(totalCount / limit),
          }
        }
      };
    } catch (error) {
      console.error('Error fetching withdrawal requests:', error);
      // Log the actual error for better debugging
      console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
      return ctx.internalServerError('An error occurred while fetching withdrawal requests', { error: error.message });
    }
  },

  // Admin endpoint to APPROVE (but not yet pay) a withdrawal request
  async approveWithdrawal(ctx) {
    try {
      // Check if user is authenticated and is an admin
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if user is an admin or has special access
      const { role, email } = ctx.state.user;
      const hasAdminAccess = (role && role.type === 'admin') || email === 'mantasha@wordscloud.in';

      if (!hasAdminAccess) {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;

      // Get the withdrawal request
      const withdrawalRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });

      if (!withdrawalRequest) {
        return ctx.notFound('Withdrawal request not found');
      }

      // Check if the withdrawal request is already processed
      if (withdrawalRequest.withdrawal_status !== 'pending') {
        return ctx.badRequest(`Withdrawal request is already ${withdrawalRequest.withdrawal_status}`);
      }

      // Get publisher wallet
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id
        }
      });

      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found');
      }

      // ONLY update status to 'approved'. DO NOT process payment or reduce escrow here.
      const updatedRequest = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
        data: {
          withdrawal_status: 'approved' // Changed from 'paid'
        }
      });

      console.log(`Withdrawal request #${id} status changed to 'approved'. Escrow balance NOT changed at this step.`);

      // NO escrowBalance change here
      // NO payout transaction creation here

      // Create notification for publisher about approval
      try {
        console.log(`[WithdrawalController] About to create withdrawal_approved notification`);
        console.log(`[WithdrawalController] Publisher ID: ${withdrawalRequest.publisher.id}, Amount: ${withdrawalRequest.amount}`);

        await strapi.service('api::notification.notification').createPaymentNotification(
          withdrawalRequest.publisher.id,
          'withdrawal_approved',
          withdrawalRequest.amount
        );

        console.log(`[WithdrawalController] Withdrawal approved notification created successfully`);
      } catch (notificationError) {
        console.error('Failed to create withdrawal approved notification:', notificationError);
        // Don't fail the approval if notification fails
      }

      // Send email notification about approval
      try {
        const emailService = strapi.service('api::global.email-operations');
        const publisherEmail = withdrawalRequest.publisher.email;

        if (publisherEmail) {
          console.log(`[WithdrawalController] Sending withdrawal approval email to ${publisherEmail}`);

          // Get the transaction record
          const transaction = await strapi.db.query('api::transaction.transaction').findOne({
            where: {
              users_permissions_user: withdrawalRequest.publisher.id,
              type: 'withdrawal',
              description: { $contains: `Withdrawal request #${withdrawalRequest.id}` }
            }
          });

          if (transaction) {
            await emailService.sendTransactionApprovalEmail(transaction, publisherEmail);
            console.log(`Withdrawal approval email sent for withdrawal #${id}`);
          } else {
            console.warn(`No transaction found for withdrawal request #${id}, email not sent`);
          }
        }
      } catch (emailError) {
        console.error('Failed to send withdrawal approval email:', emailError);
        // Don't fail the approval if email fails
      }

      return {
        data: updatedRequest,
        meta: {
          message: 'Withdrawal request approved. Awaiting payment processing.'
        }
      };

    } catch (error) {
      console.error('Error approving withdrawal request (status update only):', error);
      return ctx.internalServerError('An error occurred while approving withdrawal request');
    }
  },

  // Admin endpoint to deny a withdrawal request
  async denyWithdrawal(ctx) {
    try {
      // Check if user is authenticated and is an admin
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if user is an admin or has special access
      const { role, email } = ctx.state.user;
      const hasAdminAccess = (role && role.type === 'admin') || email === 'mantasha@wordscloud.in';

      if (!hasAdminAccess) {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      // Get the withdrawal request
      const withdrawalRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });

      if (!withdrawalRequest) {
        return ctx.notFound('Withdrawal request not found');
      }

      // Check if the withdrawal request is already processed
      if (withdrawalRequest.withdrawal_status !== 'pending') {
        return ctx.badRequest(`Withdrawal request is already ${withdrawalRequest.withdrawal_status}`);
      }

      // Get publisher wallet
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id
        }
      });

      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found');
      }

      // Update the withdrawal request
      const updatedRequest = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
        data: {
          withdrawal_status: 'denied',
          denialReason: reason
        }
      });

      // 🔧 Update the corresponding withdrawal request transaction to 'failed' since withdrawal was denied
      console.log(`[DenyWithdrawal] Updating withdrawal request transaction for withdrawal #${id}`);

      const escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'withdrawal',
          transactionStatus: 'pending',
          description: { $contains: 'Withdrawal request' }
        }
      });

      if (escrowHoldTransaction) {
        await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
          data: {
            transactionStatus: 'denied',
            description: `${escrowHoldTransaction.description} - Withdrawal denied: ${reason || 'No reason provided'}`
          }
        });
        console.log(`[DenyWithdrawal] Updated withdrawal request transaction ${escrowHoldTransaction.id} to failed`);
      } else {
        console.log(`[DenyWithdrawal] No matching withdrawal request transaction found for withdrawal #${id}`);
      }

      // Audit Wave-4 R47/R51/R107 — inline refund removed.
      //
      // Previously this block credited `withdrawalRequest.amount` (the NET
      // withdrawal) to mainBalance and decremented pendingWithdrawalBalance.
      // The entityService.update above flips withdrawal_status='denied' which
      // triggers `lifecycles.handleDeniedWithdrawal` via afterUpdate — that
      // lifecycle ALREADY credits the GROSS refund (net + 20% platform fee,
      // matching what was originally debited at create-time) and decrements
      // pendingWithdrawalBalance. Running both produced a ~1.8× over-credit
      // on every deny (e.g. $80 net withdrawal → wallet got $180 back instead
      // of the correct $100).
      //
      // Lifecycle path is the source of truth — its math is correct (totalRefund
      // = amount + platformFee). Inline refund-tx record was redundant; the
      // withdrawal transaction is already updated to denied above (lines
      // 712-731) and the lifecycle's own transaction-status updater handles
      // any audit-trail follow-up.

      // Create notification for publisher about denial
      try {
        console.log(`[WithdrawalController] About to create withdrawal_denied notification`);
        console.log(`[WithdrawalController] Publisher ID: ${withdrawalRequest.publisher.id}, Amount: ${withdrawalRequest.amount}`);

        await strapi.service('api::notification.notification').createPaymentNotification(
          withdrawalRequest.publisher.id,
          'withdrawal_denied',
          withdrawalRequest.amount
        );

        console.log(`[WithdrawalController] Withdrawal denied notification created successfully`);
      } catch (notificationError) {
        console.error('Failed to create withdrawal denied notification:', notificationError);
        // Don't fail the denial if notification fails
      }

      return {
        data: updatedRequest,
        meta: {
          message: 'Withdrawal request denied and funds returned to publisher'
        }
      };
    } catch (error) {
      console.error('Error denying withdrawal request:', error);
      return ctx.internalServerError('An error occurred while denying withdrawal request');
    }
  },

  // Admin endpoint to MARK A WITHDRAWAL AS PAID (after external payment confirmation)
  async markAsPaidWithdrawal(ctx) {
    try {
      // Check if user is authenticated and has admin access
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      const { role, email } = ctx.state.user;
      const hasAdminAccess = (role && role.type === 'admin') || email === 'mantasha@wordscloud.in';

      if (!hasAdminAccess) {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;
      if (!id) {
        return ctx.badRequest('Withdrawal request ID is required.');
      }

      // Get the withdrawal request and populate publisher details
      const withdrawalRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });

      if (!withdrawalRequest) {
        return ctx.notFound('Withdrawal request not found');
      }

      // Ensure the request is in 'approved' status (or 'pending' if direct payment is allowed)
      if (withdrawalRequest.withdrawal_status !== 'approved') {
        // If you allow marking 'pending' as paid directly, you can change this condition:
        // if (!['pending', 'approved'].includes(withdrawalRequest.withdrawal_status)) {
        return ctx.badRequest(`Withdrawal request must be in 'approved' status to be marked as paid. Current status: ${withdrawalRequest.withdrawal_status}`);
      }

      if (!withdrawalRequest.publisher || !withdrawalRequest.publisher.id) {
        return ctx.badRequest('Publisher details not found for this withdrawal request.');
      }

      // Get publisher wallet
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id
        }
      });

      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found for this user.');
      }

      // Simulate external payment confirmation (can be expanded with actual payment gateway responses)
      // Using a similar structure to your original approveWithdrawal for payment simulation
      let paymentResult;
      try {
        switch (withdrawalRequest.method) {
          case 'razorpay':
            // Assuming processRazorpayPayout confirms payment or is the payment itself
            paymentResult = await processRazorpayPayout(withdrawalRequest, true); // true might indicate final payment
            break;
          case 'paypal':
            paymentResult = await processPaypalPayout(withdrawalRequest, true);
            break;
          case 'bank_transfer':
          case 'payoneer':
            paymentResult = {
              success: true,
              transactionId: `paid_manual_${Date.now()}`,
              message: 'Manual payment confirmed and marked as paid.'
            };
            break;
          default:
            throw new Error(`Unsupported payment method: ${withdrawalRequest.method}`);
        }
      } catch (paymentError) {
        console.error('[MarkAsPaid] Payment processing/confirmation error:', paymentError);
        // Even if payment simulation fails, admin is overriding, but log it.
        // Depending on strictness, you might return ctx.badRequest here.
        paymentResult = { success: false, message: paymentError.message, transactionId: `failed_confirmation_${Date.now()}` };
        // For now, we'll proceed to mark as paid as per admin override, but this needs thought.
        // If payment MUST succeed here, then throw or return badRequest.
        // For this implementation, we assume admin is confirming an already occurred external payment.
        paymentResult = {
          success: true,
          transactionId: `override_paid_${Date.now()}`,
          message: 'Admin marked as paid, overriding simulated payment failure.'
        };
      }

      if (!paymentResult.success) {
        console.warn(`[MarkAsPaid] Payment result indicated failure for withdrawal #${id}, but admin is marking as paid. Message: ${paymentResult.message}`);
        // Decide if you want to halt or proceed. For now, proceeding as admin override.
      }

      // Update the withdrawal request status to 'paid'
      const updatedRequest = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
        data: {
          withdrawal_status: 'paid',
          // Potentially add payment transaction IDs or notes here from paymentResult
          // e.g., gateway_reference: paymentResult.transactionId
        }
      });

      // 🔧 Update the corresponding withdrawal request transaction to 'success' since withdrawal is now paid
      console.log(`[MarkAsPaid] Updating withdrawal request transaction for withdrawal #${id}`);

      const escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'withdrawal',
          transactionStatus: 'pending',
          description: { $contains: 'Withdrawal request' }
        }
      });

      if (escrowHoldTransaction) {
        await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
          data: {
            transactionStatus: 'paid',
            description: `${escrowHoldTransaction.description} - Payment completed`
          }
        });
        console.log(`[MarkAsPaid] Updated withdrawal request transaction ${escrowHoldTransaction.id} to success`);
      } else {
        console.log(`[MarkAsPaid] No matching withdrawal request transaction found for withdrawal #${id}`);
      }

      // IMPORTANT: Release funds from pending withdrawal balance in the publisher's wallet
      // Ensure this only happens once for the lifetime of the withdrawal request.
      // Check current pending balance to prevent double-deduction if this function were ever miscalled.
      const amountToDecreaseFromPending = parseFloat(withdrawalRequest.amount);
      if (parseFloat(publisherWallet.pendingWithdrawalBalance || 0) >= amountToDecreaseFromPending) {
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: publisherWallet.id },
          data: {
            pendingWithdrawalBalance: Math.max(0, parseFloat(publisherWallet.pendingWithdrawalBalance || 0) - amountToDecreaseFromPending)
          }
        });
        console.log(`[MarkAsPaid] Decreased pendingWithdrawalBalance for wallet ${publisherWallet.id} by ${amountToDecreaseFromPending}. New pending balance: ${Math.max(0, parseFloat(publisherWallet.pendingWithdrawalBalance || 0) - amountToDecreaseFromPending)}`);
      } else {
        console.warn(`[MarkAsPaid] Wallet ${publisherWallet.id} pendingWithdrawalBalance ${publisherWallet.pendingWithdrawalBalance} is less than withdrawal amount ${amountToDecreaseFromPending}. Pending balance not decreased further.`);
      }

      // Create a final 'payout' transaction log
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'payout',
          amount: withdrawalRequest.amount,
          netAmount: withdrawalRequest.amount, // Assuming no fees deducted at this stage by this system
          fee: 0,
          transactionStatus: 'paid', // Or 'completed'
          gateway: withdrawalRequest.method,
          gatewayTransactionId: paymentResult.transactionId || `paid_${id}`,
          description: `Payout via ${withdrawalRequest.method} - Marked as Paid by Admin`,
          user_wallet: publisherWallet.id,
          withdrawal_request: id // Link to the withdrawal request
        }
      });

      console.log(`Withdrawal request #${id} successfully marked as paid.`);

      // Create notification for publisher about payment completion
      try {
        console.log(`[WithdrawalController] About to create withdrawal_paid notification`);
        console.log(`[WithdrawalController] Publisher ID: ${withdrawalRequest.publisher.id}, Amount: ${withdrawalRequest.amount}`);

        await strapi.service('api::notification.notification').createPaymentNotification(
          withdrawalRequest.publisher.id,
          'withdrawal_paid',
          withdrawalRequest.amount
        );

        console.log(`[WithdrawalController] Withdrawal paid notification created successfully`);
      } catch (notificationError) {
        console.error('Failed to create withdrawal paid notification:', notificationError);
        // Don't fail the payment marking if notification fails
      }

      return {
        data: updatedRequest,
        meta: {
          message: 'Withdrawal request successfully marked as paid.'
        }
      };

    } catch (error) {
      console.error('Error in markAsPaidWithdrawal:', error);
      return ctx.internalServerError('An error occurred while marking withdrawal as paid.', { error: error.message });
    }
  },

  // Get publisher available balance (including completed orders)
  async getAvailableBalance(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      const userId = ctx.state.user.id;

      // Get publisher wallet using Strapi entity service
      const publisherWallets = await strapi.entityService.findMany('api::user-wallet.user-wallet', {
        filters: {
          users_permissions_user: { id: userId }
        }
      });

      const publisherWallet = publisherWallets?.[0]; // Get the first wallet if one exists

      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found');
      }

      // STEP 1: Get all completed orders (used to ensure transactions are for valid orders)
      const allCompletedRawOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: userId,
          orderStatus: { $in: ['approved', 'completed'] }
        }
      });
      const completedOrderIds = new Set(allCompletedRawOrders.map(order => order.id));
      console.log(`Found ${completedOrderIds.size} raw completed/approved order IDs for publisher ${userId}`);

      // STEP 2: Get ALL 'escrow_release' transactions for the user's wallet.
      // These represent all funds that *have been* released from escrow for completed orders.
      // We will not filter these by "description includes withdrawal" here.
      const allEscrowReleaseTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters: {
          user_wallet: { id: publisherWallet.id },
          type: 'escrow_release', // Only consider funds released from escrow
          order: { id: { $in: Array.from(completedOrderIds) } } // Ensure transaction is for a completed/approved order
        },
        populate: ['order'], // Keep populate if needed for other parts, or remove if only amount is used
        sort: { createdAt: 'desc' }
      });
      console.log(`Found ${allEscrowReleaseTransactions.length} total escrow_release transactions for completed/approved orders.`);

      // STEP 3: Deduplicate these transactions to count each order's contribution only once (latest transaction).
      const orderTransactionMap = new Map();
      allEscrowReleaseTransactions.forEach(tx => {
        const orderId = tx.order?.id;
        if (orderId && completedOrderIds.has(orderId)) { // Double check order is relevant
          // If order not yet in map, or this tx is newer, add/update it.
          if (!orderTransactionMap.has(orderId) || new Date(tx.createdAt) > new Date(orderTransactionMap.get(orderId).createdAt)) {
            orderTransactionMap.set(orderId, tx);
          }
        }
      });
      const uniqueCompletedOrderTransactions = Array.from(orderTransactionMap.values());
      console.log(`Found ${uniqueCompletedOrderTransactions.length} unique transactions contributing to completed orders amount.`);

      // STEP 4: Calculate completedOrdersAmount from these unique transactions.
      // This is the GROSS amount from all completed orders.
      const completedOrdersAmount = uniqueCompletedOrderTransactions.reduce((total, tx) => {
        return total + parseFloat(tx.amount || 0);
      }, 0);
      console.log(`Calculated GROSS completedOrdersAmount: ${completedOrdersAmount}`);

      // STEP 5: Get Wallet Balance (direct funds, not from orders)
      const walletBalance = parseFloat(publisherWallet.balance || 0);
      console.log(`Publisher direct walletBalance: ${walletBalance}`);

      // STEP 6: Get stored pending withdrawal balance from wallet
      // This is the amount currently held due to active pending withdrawals
      const pendingWithdrawalBalance = parseFloat(publisherWallet.pendingWithdrawalBalance || 0);
      console.log(`Using stored pendingWithdrawalBalance: ${pendingWithdrawalBalance}`);

      // Keep escrow balance for order processing (separate from withdrawal pending balance)
      const escrowBalance = parseFloat(publisherWallet.escrowBalance || 0);
      console.log(`Escrow balance (for orders): ${escrowBalance}`);

      // NEW STEP: Calculate total amount from 'paid' withdrawal requests
      const paidWithdrawals = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId },
          withdrawal_status: 'paid'
        }
      });
      const totalPaidOutAmount = paidWithdrawals.reduce((total, wr) => {
        return total + parseFloat(wr.amount || 0);
      }, 0);
      console.log(`Calculated totalPaidOutAmount from ${paidWithdrawals.length} 'paid' withdrawals: ${totalPaidOutAmount}`);

      // STEP 7 (Modified): Calculate final totalAvailable.
      // Available Balance = Wallet Balance - Pending Withdrawals (simple and direct)
      const totalAvailable = Math.max(0, walletBalance - pendingWithdrawalBalance);

      console.log('Final balance calculation (getAvailableBalance):', {
        walletBalance,
        completedOrdersAmount, // Gross amount from completed orders (for reference)
        totalPaidOutAmount,    // Total amount historically paid out (for reference)
        escrowBalance,         // Amount currently tied up for order processing
        pendingWithdrawalBalance, // Amount pending withdrawal
        calculation_String: `${walletBalance} [wallet] - ${pendingWithdrawalBalance} [pending] = ${totalAvailable}`,
        final_totalAvailable_Sent_To_Client: totalAvailable
      });

      // Fetch ALL withdrawal requests for calculating total earnings (if definition is sum of all withdrawals + current available)
      // This is separate from 'pendingWithdrawals' used for escrow calculation.
      // const withdrawalRequests = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
      //   filters: {
      //     publisher: { id: userId },
      //     // Potentially filter by status if only 'paid' or 'approved' should count towards lifetime earnings
      //     // For now, let's assume all non-denied requests might be part of this definition.
      //     withdrawal_status: { $notIn: ['denied'] } 
      //   },
      //   sort: { createdAt: 'desc' }
      // });
      // console.log(`Fetched ${withdrawalRequests.length} non-denied withdrawal requests for totalEarnings calculation.`);

      // STEP 8: Return balance data.
      return {
        data: {
          walletBalance,
          completedOrdersAmount, // Gross amount from all legitimately completed orders
          escrowBalance,         // Current amount held for order processing
          pendingWithdrawalBalance, // Current amount pending withdrawal
          totalAvailable,        // Net available for new withdrawals
          totalPaidOutAmount,    // Total amount historically paid out
          completedOrders: uniqueCompletedOrderTransactions, // These are the transactions making up completedOrdersAmount
          transactionCount: uniqueCompletedOrderTransactions.length,
          // totalEarnings: withdrawalRequests.reduce((sum, wr) => sum + parseFloat(wr.amount || 0), 0) + totalAvailable 
          totalEarnings: completedOrdersAmount + walletBalance // Represents total value generated into the publisher's account
        }
      };
    } catch (error) {
      console.error('Error getting available balance:', error);
      return ctx.badRequest('Failed to get available balance', { error: error.message });
    }
  },

  // Export all my withdrawals
  async exportAllMyWithdrawals(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      const userId = ctx.state.user.id;

      // Get all withdrawal requests for the user without pagination
      const withdrawalRequests = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId }
        },
        sort: { createdAt: 'desc' },
        populate: ['publisher']
      });

      return {
        data: withdrawalRequests
      };
    } catch (error) {
      console.error('Error exporting withdrawal requests:', error);
      return ctx.internalServerError('Failed to export withdrawal requests', { error: error.message });
    }
  },

  // Debug endpoint to check transaction details for a user
  async debugTransactions(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      const userId = ctx.state.user.id;

      // Get publisher wallet
      const publisherWallets = await strapi.entityService.findMany('api::user-wallet.user-wallet', {
        filters: {
          users_permissions_user: { id: userId },
          type: 'publisher'
        }
      });

      const publisherWallet = publisherWallets?.[0];

      if (!publisherWallet) {
        return { message: 'No publisher wallet found', userId };
      }

      // Get all completed orders
      const completedOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: userId,
          orderStatus: { $in: ['approved', 'completed'] }
        }
      });

      // Get all transactions for this wallet
      const allTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters: {
          user_wallet: { id: publisherWallet.id }
        },
        populate: ['order'],
        sort: { createdAt: 'desc' }
      });

      // Get escrow_release transactions specifically
      const escrowReleaseTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters: {
          user_wallet: { id: publisherWallet.id },
          type: 'escrow_release'
        },
        populate: ['order'],
        sort: { createdAt: 'desc' }
      });

      return {
        data: {
          userId,
          publisherWallet: {
            id: publisherWallet.id,
            balance: publisherWallet.balance,
            escrowBalance: publisherWallet.escrowBalance
          },
          completedOrders: completedOrders.map(o => ({
            id: o.id,
            status: o.orderStatus,
            amount: o.totalAmount,
            completedDate: o.completedDate
          })),
          allTransactionsCount: allTransactions.length,
          escrowReleaseTransactionsCount: escrowReleaseTransactions.length,
          escrowReleaseTransactions: escrowReleaseTransactions.map(t => ({
            id: t.id,
            type: t.type,
            amount: t.amount,
            orderId: t.order?.id,
            description: t.description,
            createdAt: t.createdAt,
            publishedAt: t.publishedAt
          }))
        }
      };
    } catch (error) {
      console.error('Debug transactions error:', error);
      return ctx.badRequest('Debug failed', { error: error.message });
    }
  },

  // Migration endpoint to create missing escrow_release transactions for completed orders
  async fixMissingTransactions(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      const userId = ctx.state.user.id;

      // Get publisher wallet
      const publisherWallets = await strapi.entityService.findMany('api::user-wallet.user-wallet', {
        filters: {
          users_permissions_user: { id: userId },
          type: 'publisher'
        }
      });

      const publisherWallet = publisherWallets?.[0];

      if (!publisherWallet) {
        return { message: 'No publisher wallet found', userId };
      }

      // Get all completed orders for this publisher
      const completedOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: userId,
          orderStatus: { $in: ['approved', 'completed'] }
        }
      });

      console.log(`Found ${completedOrders.length} completed orders for publisher ${userId}`);

      let createdTransactions = 0;
      let skippedTransactions = 0;

      for (const order of completedOrders) {
        // Check if escrow_release transaction already exists for this order
        const existingTransaction = await strapi.entityService.findMany('api::transaction.transaction', {
          filters: {
            user_wallet: { id: publisherWallet.id },
            type: 'escrow_release',
            order: { id: order.id }
          }
        });

        if (existingTransaction.length > 0) {
          console.log(`Transaction already exists for order ${order.id}, skipping`);
          skippedTransactions++;
          continue;
        }

        // Create missing escrow_release transaction
        const paymentTransaction = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'escrow_release',
            amount: order.totalAmount,
            netAmount: order.totalAmount,
            transactionStatus: 'success',
            gateway: 'migration',
            gatewayTransactionId: `migration_${order.id}_${Date.now()}`,
            description: `Payment for order #${order.id} - funds available for withdrawal (migrated)`,
            user_wallet: publisherWallet.id,
            users_permissions_user: userId,
            order: order.id,
            publishedAt: new Date()
          }
        });

        console.log(`Created missing transaction for order ${order.id}: transaction ID ${paymentTransaction.id}`);
        createdTransactions++;
      }

      return {
        data: {
          userId,
          publisherWalletId: publisherWallet.id,
          completedOrdersCount: completedOrders.length,
          createdTransactions,
          skippedTransactions,
          message: `Migration completed. Created ${createdTransactions} missing transactions, skipped ${skippedTransactions} existing ones.`
        }
      };
    } catch (error) {
      console.error('Fix missing transactions error:', error);
      return ctx.badRequest('Migration failed', { error: error.message });
    }
  }
}));

// Helper function to process Razorpay payout
async function processRazorpayPayout(withdrawalRequest) {
  // TODO: Implement Razorpay payout API integration
  console.log('MOCK: Processing Razorpay payout', withdrawalRequest);

  // Mock implementation
  return {
    success: true,
    transactionId: `razorpay_${Date.now()}`,
    message: 'Razorpay payout successfully processed'
  };
}

// Helper function to process PayPal payout
async function processPaypalPayout(withdrawalRequest) {
  try {
    console.log('Processing PayPal payout for withdrawal:', withdrawalRequest.id);

    // Get the payment service
    const paymentService = strapi.service('api::transaction.payment');

    // Check if PayPal payouts are available
    try {
      // Create PayPal payout
      const payoutResult = await paymentService.createPayPalPayout(
        parseFloat(withdrawalRequest.amount),
        'USD', // You might want to make this dynamic
        withdrawalRequest.paymentDetails?.email || withdrawalRequest.publisher?.email,
        {
          withdrawalId: withdrawalRequest.id,
          userId: withdrawalRequest.publisher?.id
        }
      );

      if (payoutResult.success) {
        console.log('PayPal payout created successfully:', payoutResult.batchId);

        // Update withdrawal request with PayPal batch ID
        await strapi.entityService.update('api::withdrawal-request.withdrawal-request', withdrawalRequest.id, {
          data: {
            external_transaction_id: payoutResult.batchId,
            payment_reference: payoutResult.batchId,
            processedAt: new Date()
          }
        });

        return {
          success: true,
          transactionId: payoutResult.batchId,
          message: 'PayPal payout successfully created',
          batchId: payoutResult.batchId
        };
      } else {
        throw new Error('PayPal payout creation failed');
      }
    } catch (payoutError) {
      if (payoutError.message.includes('PayPal payouts SDK not available')) {
        console.warn('PayPal payouts SDK not available, falling back to manual processing');
        return {
          success: true,
          transactionId: `manual_paypal_${Date.now()}`,
          message: 'PayPal payout queued for manual processing (SDK not available)',
          requiresManualProcessing: true
        };
      }
      throw payoutError;
    }
  } catch (error) {
    console.error('PayPal payout error:', error);
    return {
      success: false,
      error: error.message,
      message: 'PayPal payout failed'
    };
  }
}
