'use strict';

/**
 * Affiliate commission engine — with configurable hold period (Phase 4).
 *
 * Lifecycle:
 *
 *   awardOnDeposit(depositTxId)
 *     ├─ config.holdPeriodDays > 0 → create ledger row as `pending`
 *     │                              (NO wallet credit yet; holdReleaseAt set)
 *     └─ config.holdPeriodDays = 0 → create + immediately approve
 *                                    (wallet credited synchronously)
 *
 *   approveMaturedCommissions()   [cron, every 10 min]
 *     → finds pending rows where holdReleaseAt <= now, approves each
 *       (credits wallet, sets approvedAt, emits real-time event)
 *
 *   reverseOnRefund(depositTxId)
 *     ├─ ledger is `pending`  → mark `cancelled`, no wallet debit
 *     │                         (nothing was credited yet)
 *     ├─ ledger is `approved` → mark `reversed`, book wallet debit
 *     │                         (mirrors pre-holdback behaviour)
 *     ├─ ledger is `accrued`  → legacy pre-holdback row, same as `approved`
 *     └─ ledger is `cancelled|reversed` → no-op (idempotent)
 *
 * Wallet-balance semantics:
 *   Only `approved` (and legacy `accrued`) rows have a corresponding
 *   wallet transaction. `pending` rows do NOT. This means the wallet is
 *   always consistent with the reconciled ledger — a pending commission
 *   is never in the balance the affiliate can spend or withdraw.
 *
 * Idempotency:
 *   Preserved by the DB UNIQUE(sourceTransaction) on the link table +
 *   status-transition guards (only `pending` can be approved; only
 *   `pending|approved|accrued` can be reversed/cancelled).
 */

const CONFIG_SERVICE = 'api::affiliate-commission-config.affiliate-commission-config';
const REFERRAL_TYPE = 'api::affiliate-referral.affiliate-referral';
const PROFILE_TYPE = 'api::affiliate-profile.affiliate-profile';
const COMMISSION_TYPE = 'api::affiliate-commission.affiliate-commission';
const TRANSACTION_TYPE = 'api::transaction.transaction';

const QUALIFYING_GATEWAYS = new Set([
  'stripe',
  'paypal',
  'razorpay',
  'bank_transfer',
  'phonepe',
]);

// Rows counted as "credited to the affiliate's wallet" — for stats + when
// reversal needs to book a debit. `accrued` is here for backward compat
// with pre-Phase-4 rows that were credited on creation.
const CREDITED_STATUSES = new Set(['approved', 'accrued']);

function roundToCents(amount) {
  return Math.round(amount * 100) / 100;
}

async function getOrCreateWallet(strapi, userId) {
  let wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
    where: { users_permissions_user: userId },
  });
  if (wallet) return wallet;
  return strapi.db.query('api::user-wallet.user-wallet').create({
    data: {
      users_permissions_user: userId,
      type: 'unified',
      balance: 0,
      mainBalance: 0,
      promoBalance: 0,
      escrowBalance: 0,
      pendingWithdrawalBalance: 0,
      currency: 'USD',
    },
  });
}

// Which gateways represent EXTERNAL money coming onto the platform (as
// opposed to `gateway=system` deposits, which are internal — publisher
// order earnings credited to the seller's wallet).
const EXTERNAL_DEPOSIT_GATEWAYS = new Set([
  'stripe', 'paypal', 'razorpay', 'phonepe', 'bank_transfer',
]);

// Transaction outflow statuses that count against retention. Pending,
// success, paid, approved all imply the money has left (or is committed
// to leaving) the platform. Failed/cancelled/denied/rejected mean the
// outflow never happened.
const ACTIVE_OUTFLOW_STATUSES = new Set([
  'pending', 'success', 'paid', 'approved',
]);

/**
 * Fund-provenance-aware wash-cycle guard.
 *
 * The naive "aggregate deposits vs aggregate withdrawals" formula is
 * wrong: publisher order earnings are recorded as `type=deposit,
 * gateway=system` in this codebase (see order.js:376), which the
 * aggregate reads as new deposits. And withdrawals aren't tagged by
 * fund source. Result: an established publisher who happens to deposit
 * $50 and later withdraw $50 of prior earnings would look like a
 * wash-cycle attack.
 *
 * Correct semantic: retention should track ONLY withdrawals attributable
 * to deposit funds. Order spend, refunds moving on-platform, and
 * withdrawals of earnings shouldn't reduce retention.
 *
 * Approach: simulate a two-bucket wallet from the ledger.
 *
 *   depositPool  = un-consumed money that entered as an external gateway
 *                  deposit (stripe/paypal/razorpay/phonepe/bank_transfer)
 *   earningsPool = un-consumed money that entered as publisher earnings,
 *                  affiliate commission approvals, or refunds
 *
 * On each outflow (order payment OR withdrawal), drain earnings FIRST,
 * deposits SECOND. Order spend is separate from withdrawal in the ledger
 * (type=payment vs type=withdrawal), and only the WITHDRAWAL portion
 * attributed to deposits counts against retention — order spend keeps
 * the money on-platform.
 *
 * Retention = 1 − min(depositWithdrawn_since_source, source_amount) / source_amount
 *
 * Runs a single indexed scan of the user's transactions. Cheap in
 * practice — most referred users have few transactions in their history.
 * If this ever becomes hot, cache per (userId, sourceDepositId) or
 * bound the lookback window.
 *
 * Returns { cancel, retentionRatio, depositWithdrawn, sourceAmount }.
 */
async function computeDepositRetention({
  referredUserId,
  sourceDepositCreatedAt,
  sourceDepositAmount,
  retentionThreshold,
  strapi,
}) {
  const nullResult = {
    cancel: false,
    retentionRatio: 1,
    depositWithdrawn: 0,
    sourceAmount: sourceDepositAmount || 0,
  };
  if (!referredUserId || !sourceDepositCreatedAt || !(sourceDepositAmount > 0)) {
    return nullResult;
  }
  try {
    const knex = strapi.db.connection;
    // Full ledger for this user, chronological. Amount is decimal in
    // the DB — cast to numeric to avoid string-coercion surprises.
    const rows = await knex('transactions')
      .join(
        'transactions_users_permissions_user_lnk as tul',
        'tul.transaction_id', '=', 'transactions.id',
      )
      .where('tul.user_id', referredUserId)
      .orderBy('transactions.created_at', 'asc')
      .orderBy('transactions.id', 'asc')
      .select(
        'transactions.id',
        'transactions.type',
        'transactions.gateway',
        'transactions.fund_source',
        'transactions.transaction_status as status',
        knex.raw('transactions.amount::numeric AS amount'),
        'transactions.created_at as created_at',
      );

    let depositPool = 0;
    let earningsPool = 0;
    let depositWithdrawnSinceSource = 0;
    const sourceTime = new Date(sourceDepositCreatedAt).getTime();

    const drainOutflow = (amount, allocatesToWithdrawn, isSinceSource) => {
      // Earnings drained first — attributes outflows to earned funds
      // before deposit funds. This is the pro-affiliate default (a user
      // with earnings can withdraw them without hurting retention).
      const fromEarnings = Math.min(amount, earningsPool);
      earningsPool -= fromEarnings;
      let fromDeposits = amount - fromEarnings;
      if (fromDeposits > depositPool) {
        // Wallet drained past deposit funds — happens when the ledger
        // includes escrow/fee moves we don't model, or after admin
        // adjustments. Cap at depositPool so the counter never goes
        // negative; the excess is effectively a no-op.
        fromDeposits = depositPool;
      }
      depositPool -= fromDeposits;
      if (allocatesToWithdrawn && isSinceSource) {
        depositWithdrawnSinceSource += fromDeposits;
      }
    };

    for (const r of rows) {
      const amount = Number(r.amount) || 0;
      if (amount <= 0) continue;
      // Promo funds live in a separate wallet bucket, don't affect retention.
      if (r.fund_source === 'promo_fund') continue;

      const status = r.status;
      const type = r.type;
      const gateway = r.gateway;
      const isSinceSource = new Date(r.created_at).getTime() >= sourceTime;

      if (type === 'deposit' && status === 'success') {
        if (EXTERNAL_DEPOSIT_GATEWAYS.has(gateway)) {
          depositPool += amount;
        } else if (gateway === 'system') {
          // Publisher order earnings, credited via order.js:376.
          earningsPool += amount;
        } else {
          // Unknown gateway — treat conservatively as earnings so we
          // never inflate depositPool with something we can't attribute.
          earningsPool += amount;
        }
      } else if (type === 'affiliate_commission' && status === 'success') {
        earningsPool += amount;
      } else if (type === 'refund' && status === 'success') {
        // Refunds credit back to wallet in this codebase (order.js). Treat
        // as earnings — the money is coming BACK, not a new external deposit.
        earningsPool += amount;
      } else if (type === 'payment' && status === 'success') {
        // Order spend. Drains wallet but MONEY STAYS ON-PLATFORM (goes to
        // escrow, then publisher). NOT counted against retention.
        drainOutflow(amount, /*allocatesToWithdrawn*/ false, isSinceSource);
      } else if (
        (type === 'withdrawal' || type === 'payout') &&
        ACTIVE_OUTFLOW_STATUSES.has(status)
      ) {
        // Money leaving the platform. Deposit-portion counts, but ONLY
        // if the outflow happened after the source deposit landed.
        drainOutflow(amount, /*allocatesToWithdrawn*/ true, isSinceSource);
      }
      // escrow_hold, escrow_release, fee, promo, affiliate_commission_reversal:
      // skip. escrow moves are internal-only from the user's mainBalance
      // perspective (payment already captured the debit). fee rows are
      // platform-side accounting. commission_reversal debits the affiliate,
      // not the referred user.
    }

    const cappedWithdrawn = Math.min(
      depositWithdrawnSinceSource,
      sourceDepositAmount,
    );
    const retentionRatio = 1 - cappedWithdrawn / sourceDepositAmount;

    return {
      cancel: retentionRatio < retentionThreshold,
      retentionRatio,
      depositWithdrawn: depositWithdrawnSinceSource,
      sourceAmount: sourceDepositAmount,
    };
  } catch (err) {
    strapi.log?.warn?.(
      `[affiliate-commission] retention check errored for user ${referredUserId} — proceeding with approval: ${err.message}`,
    );
    return nullResult;
  }
}

module.exports = ({ strapi }) => {
  /**
   * Book the wallet-credit side of an approval. Extracted so both the
   * immediate-approval path (holdPeriodDays=0) and the cron worker can
   * share the exact same wallet-mutation semantics.
   *
   * Runs INSIDE an existing strapi.db.transaction. Returns the wallet-side
   * transaction row id so the caller can link it into the ledger.
   */
  async function creditWalletForCommission({ ledgerId, affiliateUserId, ratePercent, commissionAmount, deposit, referralId, profileId }) {
    const wallet = await getOrCreateWallet(strapi, affiliateUserId);
    const currentMain = Number(wallet.mainBalance || 0);
    const currentTotal = Number(wallet.balance || 0);
    const newMain = roundToCents(currentMain + commissionAmount);
    const newTotal = roundToCents(currentTotal + commissionAmount);

    await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
      data: { mainBalance: newMain, balance: newTotal },
    });

    const walletTx = await strapi.entityService.create(TRANSACTION_TYPE, {
      data: {
        type: 'affiliate_commission',
        amount: commissionAmount,
        netAmount: commissionAmount,
        fee: 0,
        transactionStatus: 'success',
        gateway: 'affiliate',
        gatewayTransactionId: `aff_c_${deposit.id}_${referralId}`,
        fund_source: 'main_fund',
        description: `Affiliate commission (${ratePercent}%) for deposit #${deposit.id}`,
        metadata: {
          affiliateReferralId: referralId,
          affiliateProfileId: profileId,
          affiliateCommissionId: ledgerId,
          sourceDepositTransactionId: deposit.id,
          sourceDepositGateway: deposit.gateway,
          ratePercentSnapshot: ratePercent,
        },
        user_wallet: wallet.id,
        users_permissions_user: affiliateUserId,
        completedAt: new Date(),
      },
    });

    try {
      const walletService = strapi.service('api::user-wallet.user-wallet');
      if (walletService?.emitBalanceUpdate) {
        walletService.emitBalanceUpdate(
          affiliateUserId,
          'affiliate_commission',
          commissionAmount,
          newTotal,
          { transactionId: walletTx.id, commissionId: ledgerId },
        );
      }
    } catch (e) {
      strapi.log.warn(
        `[affiliate-commission] emitBalanceUpdate failed for user ${affiliateUserId}: ${e.message}`,
      );
    }

    return walletTx.id;
  }

  return {
    /**
     * Award commission for a confirmed deposit.
     *
     * With holdPeriodDays > 0: creates a `pending` ledger row and NO wallet
     * credit. The credit lands when approveMaturedCommissions() runs after
     * the hold period elapses.
     *
     * With holdPeriodDays = 0: creates a ledger row already in `approved`
     * state + books the wallet credit synchronously (equivalent to
     * pre-Phase-4 behaviour, useful for tests + platforms that don't
     * want holdback).
     *
     * Idempotent under duplicate webhook + verify-callback firings via
     * DB UNIQUE(sourceTransaction).
     */
    async awardOnDeposit({ depositTransactionId }) {
      if (!depositTransactionId) return null;

      const existing = await strapi.db.query(COMMISSION_TYPE).findOne({
        where: { sourceTransaction: depositTransactionId },
      });
      if (existing) return existing;

      const deposit = await strapi.entityService.findOne(
        TRANSACTION_TYPE,
        depositTransactionId,
        { populate: { users_permissions_user: true, user_wallet: true } },
      );
      if (!deposit) return null;

      if (deposit.type !== 'deposit') return null;
      if (deposit.transactionStatus !== 'success') return null;
      if (!QUALIFYING_GATEWAYS.has(deposit.gateway)) return null;
      if (deposit.fund_source && deposit.fund_source !== 'main_fund') return null;

      const referredUserId = deposit.users_permissions_user?.id;
      if (!referredUserId) return null;

      const referral = await strapi.db.query(REFERRAL_TYPE).findOne({
        where: { referredUser: referredUserId },
        populate: { affiliate: true, referredUser: true },
      });
      if (!referral) return null;
      if (referral.status !== 'active') return null;

      if (referral.affiliate?.user && referral.affiliate.user === referredUserId) {
        return null;
      }

      const profile = await strapi.entityService.findOne(
        PROFILE_TYPE,
        referral.affiliate.id,
        { populate: { user: true } },
      );
      if (!profile) return null;
      if (profile.status !== 'active') return null;
      if (profile.commissionsEnabled === false) return null;
      if (!profile.user?.id) return null;

      const config = await strapi.service(CONFIG_SERVICE).get();
      if (!config?.enabled) return null;
      const ratePercent = Number(config.defaultRatePercent);
      if (!Number.isFinite(ratePercent) || ratePercent <= 0) return null;

      // Snapshot the hold period at accrual time. Immutable per row —
      // admin config changes after accrual never affect in-flight commissions.
      // Note: Number(null) === 0, so we can't just Number() the config value.
      // A config row created before the holdPeriodDays column existed has
      // holdPeriodDays=null; treat that as the schema default (15), not 0.
      const cfgHold = config.holdPeriodDays;
      const rawHold = cfgHold === null || cfgHold === undefined ? 15 : Number(cfgHold);
      const heldForDays = Number.isFinite(rawHold) && rawHold >= 0 ? Math.min(rawHold, 365) : 15;

      const depositAmount = Number(deposit.amount);
      if (!Number.isFinite(depositAmount) || depositAmount <= 0) return null;

      const commissionAmount = roundToCents((depositAmount * ratePercent) / 100);
      if (commissionAmount <= 0) return null;

      const holdReleaseAt = heldForDays > 0
        ? new Date(Date.now() + heldForDays * 24 * 60 * 60 * 1000)
        : null;
      const initialStatus = heldForDays > 0 ? 'pending' : 'approved';

      try {
        return await strapi.db.transaction(async () => {
          // Create the ledger row first — UNIQUE(sourceTransaction) guards
          // against race duplicates before we touch the wallet.
          const ledger = await strapi.entityService.create(COMMISSION_TYPE, {
            data: {
              affiliate: profile.id,
              referral: referral.id,
              referredUser: referredUserId,
              sourceTransaction: deposit.id,
              depositAmount,
              depositCurrency: 'USD',
              paymentGateway: deposit.gateway,
              ratePercent,
              commissionAmount,
              commissionCurrency: 'USD',
              status: initialStatus,
              heldForDays,
              holdReleaseAt,
              approvedAt: initialStatus === 'approved' ? new Date() : null,
            },
          });

          // Wallet credit only for immediate-approval path. Pending rows
          // stay off the wallet until the cron matures them.
          if (initialStatus === 'approved') {
            const walletTxId = await creditWalletForCommission({
              ledgerId: ledger.id,
              affiliateUserId: profile.user.id,
              ratePercent,
              commissionAmount,
              deposit,
              referralId: referral.id,
              profileId: profile.id,
            });
            await strapi.entityService.update(COMMISSION_TYPE, ledger.id, {
              data: { walletTransaction: walletTxId },
            });
          }

          strapi.log.info(
            initialStatus === 'pending'
              ? `[affiliate-commission] ⏱ Pending $${commissionAmount} (${ratePercent}%) for affiliate ${profile.id} — matures ${holdReleaseAt.toISOString()}`
              : `[affiliate-commission] ✅ Accrued $${commissionAmount} (${ratePercent}%) to affiliate ${profile.id} for deposit ${deposit.id} (${deposit.gateway})`,
          );

          return ledger;
        });
      } catch (err) {
        const isUnique = err?.code === '23505' || /duplicate|unique/i.test(err?.message || '');
        if (isUnique) {
          strapi.log.info(
            `[affiliate-commission] idempotency: another writer already accrued for deposit ${depositTransactionId}`,
          );
          return strapi.db.query(COMMISSION_TYPE).findOne({
            where: { sourceTransaction: depositTransactionId },
          });
        }
        strapi.log.error(
          `[affiliate-commission] awardOnDeposit failed for deposit ${depositTransactionId}: ${err.message}`,
        );
        throw err;
      }
    },

    /**
     * Cron entry point: mature every `pending` row whose holdReleaseAt has
     * passed. Called every 10 min from bootstrap. Idempotent — a row that
     * has already been approved is skipped by the WHERE clause. Errors on
     * individual rows are swallowed so one bad row can't stop the batch.
     */
    async approveMaturedCommissions() {
      const now = new Date();
      const matured = await strapi.db.query(COMMISSION_TYPE).findMany({
        where: {
          status: 'pending',
          holdReleaseAt: { $lte: now },
        },
        populate: {
          affiliate: { populate: { user: true } },
          referral: true,
          referredUser: true,
          sourceTransaction: true,
        },
        limit: 500,
      });
      if (matured.length === 0) return { approved: 0, failed: 0, cancelled: 0 };

      // Load global config ONCE for the batch — the retention threshold is
      // the same for every row processed in this tick. Value is applied
      // per-commission at check time; changing it later doesn't retroactively
      // affect already-approved rows.
      const cfg = await strapi.service(CONFIG_SERVICE).get();
      const rawRetention = cfg?.depositRetentionThresholdPct;
      const retentionCheckEnabled =
        rawRetention !== null && rawRetention !== undefined && Number(rawRetention) > 0;
      const retentionThreshold = retentionCheckEnabled ? Number(rawRetention) / 100 : 0;

      let approved = 0;
      let failed = 0;
      let cancelled = 0;
      for (const ledger of matured) {
        try {
          // Anti-wash-cycle check: since the source deposit landed, has the
          // referred user withdrawn/refunded most of what they deposited?
          // If yes, cancel — the platform didn't actually see net inflow
          // and the affiliate shouldn't earn commission on a round-trip.
          //
          // Runs OUTSIDE the approval transaction so its read isn't
          // affected by the write we're about to attempt.
          if (retentionCheckEnabled) {
            const sourceDepositAmount =
              Number(ledger.depositAmount) ||
              Number(ledger.sourceTransaction?.amount) ||
              0;
            const decision = await computeDepositRetention({
              referredUserId: ledger.referredUser?.id,
              sourceDepositCreatedAt: ledger.sourceTransaction?.createdAt,
              sourceDepositAmount,
              retentionThreshold,
              strapi,
            });
            if (decision.cancel) {
              await strapi.entityService.update(COMMISSION_TYPE, ledger.id, {
                data: {
                  status: 'cancelled',
                  cancelledAt: new Date(),
                  reversalReason:
                    `Wash-cycle guard: referred user withdrew $${decision.depositWithdrawn.toFixed(2)}` +
                    ` of the source deposit ($${sourceDepositAmount.toFixed(2)}) off the platform` +
                    ` — retention ${(decision.retentionRatio * 100).toFixed(1)}%` +
                    ` < threshold ${(retentionThreshold * 100).toFixed(0)}%.` +
                    ' Order spend, refunds, and earnings-withdrawals were excluded from this calculation.' +
                    ' No wallet debit — pending commission was never credited.',
                },
              });
              cancelled++;
              strapi.log.info(
                `[affiliate-commission] Wash-cycle cancel: ledger ${ledger.id} — ` +
                `source=$${sourceDepositAmount} depositWithdrawn=$${decision.depositWithdrawn.toFixed(2)} ` +
                `retention=${(decision.retentionRatio * 100).toFixed(1)}%`,
              );
              continue;
            }
          }

          await strapi.db.transaction(async () => {
            // Re-read under the tx to avoid double-approval race with a
            // concurrent invocation (rare — cron runs single-instance —
            // but cheap to guard).
            const fresh = await strapi.db.query(COMMISSION_TYPE).findOne({
              where: { id: ledger.id },
            });
            if (!fresh || fresh.status !== 'pending') return;

            const affiliateUserId = ledger.affiliate?.user?.id;
            if (!affiliateUserId) {
              throw new Error(`ledger ${ledger.id} has no affiliate user id`);
            }

            const walletTxId = await creditWalletForCommission({
              ledgerId: ledger.id,
              affiliateUserId,
              ratePercent: Number(ledger.ratePercent),
              commissionAmount: Number(ledger.commissionAmount),
              deposit: ledger.sourceTransaction,
              referralId: ledger.referral?.id,
              profileId: ledger.affiliate.id,
            });

            await strapi.entityService.update(COMMISSION_TYPE, ledger.id, {
              data: {
                status: 'approved',
                approvedAt: new Date(),
                walletTransaction: walletTxId,
              },
            });
          });
          approved++;
        } catch (err) {
          failed++;
          strapi.log.error(
            `[affiliate-commission] failed to approve ledger ${ledger.id}: ${err.message}`,
          );
        }
      }

      if (approved > 0 || cancelled > 0 || failed > 0) {
        strapi.log.info(
          `[affiliate-commission] cron: ${approved} approved, ${cancelled} cancelled (wash-cycle), ${failed} failed`,
        );
      }
      return { approved, failed, cancelled };
    },

    /**
     * Handle a refund/reversal/chargeback of the underlying deposit.
     * Forks by current status:
     *   pending  → cancelled (no wallet debit — nothing was credited)
     *   approved → reversed  (wallet debit + reversal transaction, unchanged)
     *   accrued  → reversed  (legacy pre-Phase-4 rows, same as approved)
     *   cancelled|reversed → no-op (idempotent)
     */
    async reverseOnRefund({ originalDepositTxId, refundTxId, reason }) {
      if (!originalDepositTxId) return null;

      const ledger = await strapi.db.query(COMMISSION_TYPE).findOne({
        where: { sourceTransaction: originalDepositTxId },
        populate: { affiliate: { populate: { user: true } } },
      });
      if (!ledger) return null;
      if (ledger.status === 'reversed' || ledger.status === 'cancelled') return ledger;

      // Path A: pending → cancelled. No wallet movement.
      if (ledger.status === 'pending') {
        try {
          const updated = await strapi.entityService.update(COMMISSION_TYPE, ledger.id, {
            data: {
              status: 'cancelled',
              cancelledAt: new Date(),
              reversalReason: reason || null,
            },
          });
          strapi.log.info(
            `[affiliate-commission] ✂️ Cancelled pending ledger ${ledger.id} (deposit ${originalDepositTxId}) — reason: ${reason || 'not given'}`,
          );
          return updated;
        } catch (err) {
          strapi.log.error(
            `[affiliate-commission] cancel-pending failed for deposit ${originalDepositTxId}: ${err.message}`,
          );
          throw err;
        }
      }

      // Path B: approved/accrued → reversed. Wallet debit path.
      if (!CREDITED_STATUSES.has(ledger.status)) {
        strapi.log.warn(
          `[affiliate-commission] unexpected status ${ledger.status} on ledger ${ledger.id} — skipping reversal`,
        );
        return ledger;
      }

      const affiliateUserId = ledger.affiliate?.user?.id;
      if (!affiliateUserId) {
        strapi.log.warn(
          `[affiliate-commission] cannot reverse ledger ${ledger.id}: affiliate user missing`,
        );
        return null;
      }

      const commissionAmount = Number(ledger.commissionAmount);

      try {
        return await strapi.db.transaction(async () => {
          const wallet = await getOrCreateWallet(strapi, affiliateUserId);
          const currentMain = Number(wallet.mainBalance || 0);
          const currentTotal = Number(wallet.balance || 0);
          const newMain = roundToCents(currentMain - commissionAmount);
          const newTotal = roundToCents(currentTotal - commissionAmount);

          await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
            data: { mainBalance: newMain, balance: newTotal },
          });

          const reversalTx = await strapi.entityService.create(TRANSACTION_TYPE, {
            data: {
              type: 'affiliate_commission_reversal',
              amount: commissionAmount,
              netAmount: commissionAmount,
              fee: 0,
              transactionStatus: 'success',
              gateway: 'affiliate',
              gatewayTransactionId: `aff_r_${originalDepositTxId}_${refundTxId || 'admin'}`,
              fund_source: 'main_fund',
              description:
                `Affiliate commission reversal for deposit #${originalDepositTxId}` +
                (reason ? ` — ${reason.slice(0, 240)}` : ''),
              metadata: {
                affiliateCommissionId: ledger.id,
                sourceDepositTransactionId: originalDepositTxId,
                refundTransactionId: refundTxId || null,
                reason: reason || null,
              },
              user_wallet: wallet.id,
              users_permissions_user: affiliateUserId,
              completedAt: new Date(),
            },
          });

          const updated = await strapi.entityService.update(COMMISSION_TYPE, ledger.id, {
            data: {
              status: 'reversed',
              reversedAt: new Date(),
              reversalReason: reason || null,
              reversalTransaction: reversalTx.id,
            },
          });

          try {
            const walletService = strapi.service('api::user-wallet.user-wallet');
            if (walletService?.emitBalanceUpdate) {
              walletService.emitBalanceUpdate(
                affiliateUserId,
                'affiliate_commission_reversal',
                -commissionAmount,
                newTotal,
                { transactionId: reversalTx.id, commissionId: ledger.id },
              );
            }
          } catch (e) {
            strapi.log.warn(
              `[affiliate-commission] emitBalanceUpdate (reversal) failed for user ${affiliateUserId}: ${e.message}`,
            );
          }

          strapi.log.info(
            `[affiliate-commission] ↩️ Reversed $${commissionAmount} on ledger ${ledger.id} (deposit ${originalDepositTxId}) — reason: ${reason || 'not given'}`,
          );

          return updated;
        });
      } catch (err) {
        strapi.log.error(
          `[affiliate-commission] reverseOnRefund failed for deposit ${originalDepositTxId}: ${err.message}`,
        );
        throw err;
      }
    },

    /**
     * Read-only helpers for admin + affiliate dashboards.
     */
    async listByAffiliate(affiliateId, { page = 1, pageSize = 20, status } = {}) {
      const where = { affiliate: affiliateId };
      if (status) where.status = status;
      const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
      const offset = Math.max((Number(page) || 1) - 1, 0) * limit;
      const [rows, total] = await Promise.all([
        strapi.db.query(COMMISSION_TYPE).findMany({
          where,
          orderBy: { createdAt: 'desc' },
          limit,
          offset,
          populate: {
            sourceTransaction: true,
            walletTransaction: true,
            referredUser: true,
          },
        }),
        strapi.db.query(COMMISSION_TYPE).count({ where }),
      ]);
      return {
        data: rows,
        meta: { page: Number(page) || 1, pageSize: limit, total, pageCount: Math.ceil(total / limit) },
      };
    },

    /**
     * Stats used by admin + affiliate dashboards.
     * Phase 4 semantics:
     *   pending           = sum of pending rows (not yet withdrawable)
     *   approved          = sum of approved + legacy 'accrued' rows
     *                       (both live in the wallet)
     *   reversed          = sum of rows reversed AFTER approval
     *                       (wallet debit was booked)
     *   cancelled         = sum of rows cancelled DURING hold (no wallet impact)
     *   lifetimeAccrued   = approved + reversed + cancelled + pending
     *                       (kept for backward compat with existing UI)
     *   last30dAccrued    = same, filtered to last 30 days
     */
    async statsByAffiliate(affiliateId) {
      const knex = strapi.db.connection;
      const [totals] = await knex('affiliate_commissions')
        .join(
          'affiliate_commissions_affiliate_lnk',
          'affiliate_commissions.id', '=', 'affiliate_commissions_affiliate_lnk.affiliate_commission_id',
        )
        .where('affiliate_commissions_affiliate_lnk.affiliate_profile_id', affiliateId)
        .select(
          knex.raw("COALESCE(SUM(CASE WHEN status = 'pending' THEN commission_amount END), 0)::numeric AS lifetime_pending"),
          knex.raw("COALESCE(SUM(CASE WHEN status IN ('approved','accrued') THEN commission_amount END), 0)::numeric AS lifetime_approved"),
          knex.raw("COALESCE(SUM(CASE WHEN status = 'reversed' THEN commission_amount END), 0)::numeric AS lifetime_reversed"),
          knex.raw("COALESCE(SUM(CASE WHEN status = 'cancelled' THEN commission_amount END), 0)::numeric AS lifetime_cancelled"),
          knex.raw("COALESCE(SUM(CASE WHEN status IN ('pending','approved','accrued','reversed','cancelled') AND created_at >= NOW() - INTERVAL '30 days' THEN commission_amount END), 0)::numeric AS last30d_accrued"),
          knex.raw("COUNT(*)::int AS total_events"),
        );

      const pending = Number(totals?.lifetime_pending || 0);
      const approved = Number(totals?.lifetime_approved || 0);
      const reversed = Number(totals?.lifetime_reversed || 0);
      const cancelled = Number(totals?.lifetime_cancelled || 0);

      return {
        lifetimePending: pending,
        lifetimeApproved: approved,
        lifetimeReversed: reversed,
        lifetimeCancelled: cancelled,
        // Available = what the affiliate can currently spend/withdraw from
        // affiliate earnings. Never negative.
        lifetimeAvailable: Math.max(0, approved - reversed),
        // Backward-compat aliases used by the current admin+client UI —
        // now sum every non-cancelled state so the "lifetime earned" number
        // still reflects what the affiliate has generated.
        lifetimeAccrued: pending + approved + reversed,
        last30dAccrued: Number(totals?.last30d_accrued || 0),
        totalEvents: Number(totals?.total_events || 0),
      };
    },
  };
};
