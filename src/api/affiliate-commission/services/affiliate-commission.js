'use strict';

/**
 * Affiliate commission engine.
 *
 * Two entry points, both invoked from payment-gateway confirmation and
 * refund paths (never from order/escrow flows):
 *
 *   awardOnDeposit({ depositTransactionId })   — after gateway confirms
 *   reverseOnRefund({ originalDepositTxId, refundTxId, reason })
 *
 * Idempotency
 * -----------
 * Multiple webhook + verify-callback firings can arrive for the same
 * deposit. Idempotency is enforced by:
 *   1. Reading the ledger for the sourceTransaction before insert
 *   2. A raw-SQL UNIQUE index on affiliate_commissions_source_transaction_lnk
 *      (added by the accompanying migration) — catches the race where two
 *      writers pass step (1) at the same time. On unique violation we
 *      swallow the error and return the already-persisted row.
 *
 * Qualifying deposits (ALL must be true)
 * --------------------------------------
 *   - transaction.type === 'deposit'
 *   - transaction.gateway ∈ {stripe, paypal, razorpay, bank_transfer, phonepe}
 *   - transaction.transactionStatus === 'success'
 *   - transaction.fund_source === 'main_fund' (or unset — legacy rows)
 *   - referred user has an active affiliate-referral row
 *   - affiliate-profile.status === 'active'
 *   - affiliate-profile.commissionsEnabled === true
 *   - global config.enabled === true
 *
 * All other transaction types (promo, escrow_*, payment, withdrawal, fee,
 * refund, payout, affiliate_*) short-circuit at the type check — orders
 * and wallet-to-escrow moves therefore CANNOT trigger commissions.
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

function roundToCents(amount) {
  return Math.round(amount * 100) / 100;
}

module.exports = ({ strapi }) => ({
  /**
   * Award commission for a confirmed deposit. Safe to call multiple times
   * for the same deposit — subsequent calls are no-ops.
   *
   * Returns the ledger row on success, or null if the deposit doesn't
   * qualify. Never throws for expected "doesn't qualify" reasons — those
   * are logged at debug level and surfaced only in the return value.
   */
  async awardOnDeposit({ depositTransactionId }) {
    if (!depositTransactionId) return null;

    // Belt-and-suspenders idempotency: check for an existing ledger row
    // BEFORE we do any of the more expensive lookups below. The unique
    // constraint on the FK is the actual race-safe guard.
    const existing = await strapi.db.query(COMMISSION_TYPE).findOne({
      where: { sourceTransaction: depositTransactionId },
    });
    if (existing) return existing;

    // Reload the deposit with everything we need to evaluate qualification.
    const deposit = await strapi.entityService.findOne(
      TRANSACTION_TYPE,
      depositTransactionId,
      { populate: { users_permissions_user: true, user_wallet: true } }
    );
    if (!deposit) return null;

    if (deposit.type !== 'deposit') return null;
    if (deposit.transactionStatus !== 'success') return null;
    if (!QUALIFYING_GATEWAYS.has(deposit.gateway)) return null;
    // fund_source is optional on legacy rows — treat missing as main_fund.
    if (deposit.fund_source && deposit.fund_source !== 'main_fund') return null;

    const referredUserId = deposit.users_permissions_user?.id;
    if (!referredUserId) return null;

    // The referred user's active referral (if any).
    const referral = await strapi.db.query(REFERRAL_TYPE).findOne({
      where: { referredUser: referredUserId },
      populate: { affiliate: true, referredUser: true },
    });
    if (!referral) return null;
    if (referral.status !== 'active') return null;

    // Guard against the deposit belonging to the affiliate themselves —
    // referral creation already blocks this, but double-check to be safe.
    if (referral.affiliate?.user && referral.affiliate.user === referredUserId) {
      return null;
    }

    // Load the profile freshly to read commissionsEnabled + status.
    const profile = await strapi.entityService.findOne(
      PROFILE_TYPE,
      referral.affiliate.id,
      { populate: { user: true } }
    );
    if (!profile) return null;
    if (profile.status !== 'active') return null;
    if (profile.commissionsEnabled === false) return null;
    if (!profile.user?.id) return null;

    // Global toggle + snapshot rate.
    const config = await strapi.service(CONFIG_SERVICE).get();
    if (!config?.enabled) return null;
    const ratePercent = Number(config.defaultRatePercent);
    if (!Number.isFinite(ratePercent) || ratePercent <= 0) return null;

    const depositAmount = Number(deposit.amount);
    if (!Number.isFinite(depositAmount) || depositAmount <= 0) return null;

    const commissionAmount = roundToCents((depositAmount * ratePercent) / 100);
    if (commissionAmount <= 0) return null;

    // Credit the affiliate's wallet + write ledger row in one atomic step.
    // If the ledger insert loses the idempotency race, we catch the unique
    // violation and roll back the wallet credit inside the same txn.
    try {
      return await strapi.db.transaction(async () => {
        // Load or create the affiliate's wallet.
        const wallet = await strapi.service('api::user-wallet.user-wallet')
          .getOrCreateWallet(profile.user.id);
        const currentMain = Number(wallet.mainBalance || 0);
        const currentTotal = Number(wallet.balance || 0);
        const newMain = roundToCents(currentMain + commissionAmount);
        const newTotal = roundToCents(currentTotal + commissionAmount);

        await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
          data: { mainBalance: newMain, balance: newTotal },
        });

        // The credit row on the affiliate's wallet.
        const walletTx = await strapi.entityService.create(TRANSACTION_TYPE, {
          data: {
            type: 'affiliate_commission',
            amount: commissionAmount,
            netAmount: commissionAmount,
            fee: 0,
            transactionStatus: 'success',
            gateway: 'affiliate',
            gatewayTransactionId: `aff_c_${deposit.id}_${referral.id}`,
            fund_source: 'main_fund',
            description: `Affiliate commission (${ratePercent}%) for deposit #${deposit.id}`,
            metadata: {
              affiliateReferralId: referral.id,
              affiliateProfileId: profile.id,
              sourceDepositTransactionId: deposit.id,
              sourceDepositGateway: deposit.gateway,
              ratePercentSnapshot: ratePercent,
            },
            user_wallet: wallet.id,
            users_permissions_user: profile.user.id,
            completedAt: new Date(),
          },
        });

        // The ledger row. UNIQUE(sourceTransaction) makes the second
        // concurrent writer's insert fail here — outer try/catch handles
        // it, transaction is rolled back, wallet credit disappears.
        const ledger = await strapi.entityService.create(COMMISSION_TYPE, {
          data: {
            affiliate: profile.id,
            referral: referral.id,
            referredUser: referredUserId,
            sourceTransaction: deposit.id,
            walletTransaction: walletTx.id,
            depositAmount,
            depositCurrency: 'USD',
            paymentGateway: deposit.gateway,
            ratePercent,
            commissionAmount,
            commissionCurrency: 'USD',
            status: 'accrued',
          },
        });

        // Emit wallet + notification events (best-effort, non-blocking).
        try {
          const walletService = strapi.service('api::user-wallet.user-wallet');
          if (walletService?.emitBalanceUpdate) {
            walletService.emitBalanceUpdate(
              profile.user.id,
              'affiliate_commission',
              commissionAmount,
              newTotal,
              { transactionId: walletTx.id, commissionId: ledger.id }
            );
          }
        } catch (e) {
          strapi.log.warn(
            `[affiliate-commission] emitBalanceUpdate failed for user ${profile.user.id}: ${e.message}`
          );
        }

        strapi.log.info(
          `[affiliate-commission] ✅ Accrued $${commissionAmount} (${ratePercent}%) ` +
          `to affiliate ${profile.id} for deposit ${deposit.id} (${deposit.gateway})`
        );

        return ledger;
      });
    } catch (err) {
      // 23505 = Postgres unique-violation. Someone else won the race —
      // read their row and return it.
      const isUnique =
        err?.code === '23505' ||
        /duplicate|unique/i.test(err?.message || '');
      if (isUnique) {
        strapi.log.info(
          `[affiliate-commission] idempotency: another writer already accrued for deposit ${depositTransactionId}`
        );
        return strapi.db.query(COMMISSION_TYPE).findOne({
          where: { sourceTransaction: depositTransactionId },
        });
      }
      strapi.log.error(
        `[affiliate-commission] awardOnDeposit failed for deposit ${depositTransactionId}: ${err.message}`
      );
      throw err;
    }
  },

  /**
   * Reverse a commission when the underlying deposit is refunded, reversed,
   * or charged back. Idempotent — a second call for the same source deposit
   * is a no-op.
   *
   * @param {object}  args
   * @param {number}  args.originalDepositTxId  the deposit whose commission
   *                                            should be reversed
   * @param {number} [args.refundTxId]          the refund/reversal row (for audit)
   * @param {string} [args.reason]              free-text audit note
   */
  async reverseOnRefund({ originalDepositTxId, refundTxId, reason }) {
    if (!originalDepositTxId) return null;

    const ledger = await strapi.db.query(COMMISSION_TYPE).findOne({
      where: { sourceTransaction: originalDepositTxId },
      populate: { affiliate: { populate: { user: true } } },
    });
    if (!ledger) return null;                    // no commission was ever accrued
    if (ledger.status === 'reversed') return ledger;  // already reversed

    const affiliateUserId = ledger.affiliate?.user?.id;
    if (!affiliateUserId) {
      strapi.log.warn(
        `[affiliate-commission] cannot reverse ledger ${ledger.id}: affiliate user missing`
      );
      return null;
    }

    const commissionAmount = Number(ledger.commissionAmount);

    try {
      return await strapi.db.transaction(async () => {
        // Debit the affiliate's wallet — even if it takes them negative.
        // This mirrors how chargeback debits are handled elsewhere in the
        // codebase; operations can chase collection separately.
        const wallet = await strapi.service('api::user-wallet.user-wallet')
          .getOrCreateWallet(affiliateUserId);
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
            gatewayTransactionId:
              `aff_r_${originalDepositTxId}_${refundTxId || 'admin'}`,
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
              { transactionId: reversalTx.id, commissionId: ledger.id }
            );
          }
        } catch (e) {
          strapi.log.warn(
            `[affiliate-commission] emitBalanceUpdate (reversal) failed for user ${affiliateUserId}: ${e.message}`
          );
        }

        strapi.log.info(
          `[affiliate-commission] ↩️ Reversed $${commissionAmount} on ledger ${ledger.id} ` +
          `(deposit ${originalDepositTxId}) — reason: ${reason || 'not given'}`
        );

        return updated;
      });
    } catch (err) {
      strapi.log.error(
        `[affiliate-commission] reverseOnRefund failed for deposit ${originalDepositTxId}: ${err.message}`
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

  async statsByAffiliate(affiliateId) {
    const knex = strapi.db.connection;
    const [totals] = await knex('affiliate_commissions')
      .join(
        'affiliate_commissions_affiliate_lnk',
        'affiliate_commissions.id',
        '=',
        'affiliate_commissions_affiliate_lnk.affiliate_commission_id'
      )
      .where('affiliate_commissions_affiliate_lnk.affiliate_profile_id', affiliateId)
      .select(
        knex.raw(
          "COALESCE(SUM(CASE WHEN status = 'accrued' THEN commission_amount END), 0)::numeric AS lifetime_accrued"
        ),
        knex.raw(
          "COALESCE(SUM(CASE WHEN status = 'reversed' THEN commission_amount END), 0)::numeric AS lifetime_reversed"
        ),
        knex.raw(
          "COALESCE(SUM(CASE WHEN status = 'accrued' AND created_at >= NOW() - INTERVAL '30 days' THEN commission_amount END), 0)::numeric AS last30d_accrued"
        ),
        knex.raw("COUNT(*)::int AS total_events")
      );
    return {
      lifetimeAccrued: Number(totals?.lifetime_accrued || 0),
      lifetimeReversed: Number(totals?.lifetime_reversed || 0),
      last30dAccrued: Number(totals?.last30d_accrued || 0),
      totalEvents: Number(totals?.total_events || 0),
    };
  },
});
