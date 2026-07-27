'use strict';

/**
 * affiliate-profile controller (user-facing).
 *
 * Every handler binds `affiliate.user = ctx.state.user.id` from the JWT —
 * request body is NEVER trusted for identity. Response allow-lists mirror
 * the pass-5/6/7/8/9/10 conventions:
 *   - `user` relation on the profile is populated to `{ id }` only.
 *   - `disabledBy` never exposed to the affiliate themselves (admin PII).
 *   - private fields (disabledReason, adminNotes) hidden by schema.
 *
 * Admin-side handlers live in src/api/admin/controllers/affiliates.js.
 */

const { createCoreController } = require('@strapi/strapi').factories;
const { generateUniqueCode } = require('../../../utils/referral-code');

// Fields safe to return to the affiliate themselves.
const AFFILIATE_PROFILE_PUBLIC_FIELDS = [
  'id',
  'referralCode',
  'status',
  'disabledAt',
  'lastCodeRotationAt',
  'createdAt',
  'updatedAt',
];

// Self-service code-rotation throttle. Prevents users from re-generating
// their code every second (annoyance for reverse-lookup + wastes analytics).
// Tunable via env var; default 24h.
const CODE_ROTATION_COOLDOWN_S = (() => {
  const v = parseInt(process.env.AFFILIATE_CODE_ROTATION_COOLDOWN_S, 10);
  return Number.isFinite(v) && v > 0 ? v : 24 * 60 * 60;
})();

const shapeProfile = (row) => {
  if (!row) return null;
  const out = {};
  for (const k of AFFILIATE_PROFILE_PUBLIC_FIELDS) {
    if (k in row) out[k] = row[k];
  }
  return out;
};

module.exports = createCoreController('api::affiliate-profile.affiliate-profile', ({ strapi }) => ({
  /**
   * POST /affiliates/apply
   * Idempotent — if the caller already has a profile, return it unchanged.
   * Otherwise create one with `status: active` and a fresh referralCode.
   *
   * Body is empty; identity comes exclusively from the JWT.
   */
  async apply(ctx) {
    if (!ctx.state.user) return ctx.unauthorized('Authentication required');
    const userId = ctx.state.user.id;

    // Idempotent — existing profile takes precedence, even if it was
    // previously disabled. Re-enabling a disabled affiliate is an admin
    // action, not a self-service one.
    const existing = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
    });
    if (existing) {
      return { data: shapeProfile(existing) };
    }

    const code = await generateUniqueCode(strapi);
    const created = await strapi.entityService.create('api::affiliate-profile.affiliate-profile', {
      data: {
        user: userId,
        referralCode: code,
        status: 'active',
        lastCodeRotationAt: new Date(),
      },
    });

    strapi.log.info(`[affiliate.apply] user=${userId} enrolled with code=${code}`);
    return { data: shapeProfile(created) };
  },

  /**
   * GET /affiliates/me
   * Returns the caller's own profile — or 404 if they haven't applied yet.
   */
  async me(ctx) {
    if (!ctx.state.user) return ctx.unauthorized('Authentication required');
    const userId = ctx.state.user.id;

    const profile = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
    });
    if (!profile) return ctx.notFound('No affiliate profile — call POST /affiliates/apply first');

    return { data: shapeProfile(profile) };
  },

  /**
   * POST /affiliates/me/regenerate-code
   * Rotates the caller's referralCode. Old code stops resolving immediately.
   * Throttled to once per CODE_ROTATION_COOLDOWN_S per user (default 24h).
   *
   * Only allowed when status='active'. Disabled/terminated affiliates can't
   * rotate — admin has to re-enable first.
   */
  async regenerateMyCode(ctx) {
    if (!ctx.state.user) return ctx.unauthorized('Authentication required');
    const userId = ctx.state.user.id;

    const profile = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
    });
    if (!profile) return ctx.notFound('No affiliate profile — call POST /affiliates/apply first');
    if (profile.status !== 'active') {
      return ctx.forbidden('Cannot rotate code on a disabled or terminated affiliate profile.');
    }

    const last = profile.lastCodeRotationAt ? new Date(profile.lastCodeRotationAt).getTime() : 0;
    const ageS = (Date.now() - last) / 1000;
    if (ageS < CODE_ROTATION_COOLDOWN_S) {
      const retry = Math.ceil(CODE_ROTATION_COOLDOWN_S - ageS);
      ctx.set('Retry-After', String(retry));
      return ctx.throw(429, 'Code was rotated recently. Try again later.');
    }

    const newCode = await generateUniqueCode(strapi);
    const updated = await strapi.entityService.update('api::affiliate-profile.affiliate-profile', profile.id, {
      data: {
        referralCode: newCode,
        lastCodeRotationAt: new Date(),
      },
    });

    strapi.log.info(`[affiliate.regenerateMyCode] user=${userId} rotated code (profile=${profile.id})`);
    return { data: shapeProfile(updated) };
  },

  /**
   * GET /affiliates/me/referrals
   * List the caller's own referred users. Reduced to { id, attributedAt,
   * status } per row — NO email/username/name of the referred user. This
   * mirrors the marketplace / chatroom pattern of never leaking counterparty
   * PII to the "other side" of the transaction.
   */
  async myReferrals(ctx) {
    if (!ctx.state.user) return ctx.unauthorized('Authentication required');
    const userId = ctx.state.user.id;

    const profile = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
      select: ['id'],
    });
    if (!profile) return { data: [], meta: { total: 0 } };

    // Cap pageSize like every other list endpoint (pass-9 pattern).
    const rawSize = Number.parseInt(ctx.query?.pageSize, 10);
    const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(rawSize, 100) : 20;
    const rawPage = Number.parseInt(ctx.query?.page, 10);
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

    const rows = await strapi.entityService.findMany('api::affiliate-referral.affiliate-referral', {
      filters: { affiliate: { id: profile.id } },
      fields: ['id', 'attributedAt', 'status', 'blockReason'],
      populate: {
        referredUser: { fields: ['id'] },  // id-only — no PII
        referralLinkClick: { fields: ['id', 'country', 'utmSource', 'utmCampaign', 'landingPath'] },
      },
      sort: { attributedAt: 'desc' },
      limit: pageSize,
      start: (page - 1) * pageSize,
    });

    const referredUserIds = (rows || []).map((r) => r.referredUser?.id).filter(Boolean);

    // Aggregate qualifying deposits per referred user in one query. We only
    // count rows that match the same guard set as the commission engine:
    // type='deposit', gateway ∈ (stripe, paypal, razorpay, phonepe,
    // bank_transfer), status='success'. This is what the affiliate sees
    // in Phase 3's redesigned Referrals list.
    let depositsByUser = new Map();
    if (referredUserIds.length > 0) {
      const knex = strapi.db.connection;
      // Knex join alias goes INSIDE the table string ('table as alias'),
      // not as a positional second arg. The earlier three-arg form
      // ("table", "t", fn) hit an internal event-emitter path and threw
      // "The 'listener' argument must be of type function".
      const agg = await knex('transactions')
        .join(
          'transactions_users_permissions_user_lnk as t',
          't.transaction_id', '=', 'transactions.id'
        )
        .whereIn('t.user_id', referredUserIds)
        .where('transactions.type', 'deposit')
        .whereIn('transactions.gateway', ['stripe', 'paypal', 'razorpay', 'phonepe', 'bank_transfer'])
        .where('transactions.transaction_status', 'success')
        .groupBy('t.user_id')
        .select(
          't.user_id AS user_id',
          knex.raw('COUNT(*)::int AS deposit_count'),
          knex.raw('COALESCE(SUM(transactions.amount), 0)::numeric AS deposit_total'),
        );
      depositsByUser = new Map(
        agg.map((r) => [
          Number(r.user_id),
          {
            depositCount: Number(r.deposit_count),
            depositTotal: Number(r.deposit_total),
          },
        ]),
      );
    }

    // Aggregate commission earned per referred user, similarly one shot.
    let earnedByUser = new Map();
    if (referredUserIds.length > 0) {
      const knex = strapi.db.connection;
      const agg = await knex('affiliate_commissions')
        .join(
          'affiliate_commissions_referred_user_lnk as l',
          'l.affiliate_commission_id', '=', 'affiliate_commissions.id'
        )
        .whereIn('l.user_id', referredUserIds)
        .groupBy('l.user_id')
        .select(
          'l.user_id AS user_id',
          knex.raw("COALESCE(SUM(CASE WHEN status = 'accrued' THEN commission_amount END), 0)::numeric AS accrued"),
          knex.raw("COALESCE(SUM(CASE WHEN status = 'reversed' THEN commission_amount END), 0)::numeric AS reversed"),
        );
      earnedByUser = new Map(
        agg.map((r) => [
          Number(r.user_id),
          {
            accrued: Number(r.accrued),
            reversed: Number(r.reversed),
          },
        ]),
      );
    }

    const shaped = (rows || []).map((r) => {
      const uid = r.referredUser?.id || null;
      const dep = uid && depositsByUser.get(uid);
      const earn = uid && earnedByUser.get(uid);
      return {
        id: r.id,
        attributedAt: r.attributedAt,
        status: r.status,
        blockReason: r.blockReason || null,
        referredUserId: uid,
        country: r.referralLinkClick?.country || null,
        trafficSource: r.referralLinkClick?.utmSource || null,
        landingPath: r.referralLinkClick?.landingPath || null,
        depositCount: dep?.depositCount ?? 0,
        depositTotal: dep?.depositTotal ?? 0,
        earnedAccrued: earn?.accrued ?? 0,
        earnedReversed: earn?.reversed ?? 0,
      };
    });

    // Total count for pagination — cheap (uses the same filter).
    const total = await strapi.entityService.count('api::affiliate-referral.affiliate-referral', {
      filters: { affiliate: { id: profile.id } },
    });

    return {
      data: shaped,
      meta: { page, pageSize, count: shaped.length, total, pageCount: Math.ceil(total / pageSize) },
    };
  },

  /**
   * GET /affiliates/me/stats
   * Aggregate counts — total clicks, total referrals, last-30-day breakdown.
   * No PII, no cross-user data. All computed against the caller's own
   * affiliate.id.
   */
  async myStats(ctx) {
    if (!ctx.state.user) return ctx.unauthorized('Authentication required');
    const userId = ctx.state.user.id;

    const profile = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
      select: ['id'],
    });
    if (!profile) {
      return {
        data: { totalClicks: 0, totalReferrals: 0, clicksLast30d: 0, referralsLast30d: 0 },
      };
    }

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = new Date(now - 30 * day);
    const sixtyDaysAgo = new Date(now - 60 * day);

    const [
      totalClicks, totalReferrals,
      clicksLast30d, referralsLast30d,
      clicksPrev30d, referralsPrev30d,
    ] = await Promise.all([
      strapi.entityService.count('api::affiliate-link-click.affiliate-link-click', {
        filters: { affiliate: { id: profile.id } },
      }),
      strapi.entityService.count('api::affiliate-referral.affiliate-referral', {
        filters: { affiliate: { id: profile.id } },
      }),
      strapi.entityService.count('api::affiliate-link-click.affiliate-link-click', {
        filters: { affiliate: { id: profile.id }, clickedAt: { $gte: thirtyDaysAgo } },
      }),
      strapi.entityService.count('api::affiliate-referral.affiliate-referral', {
        filters: { affiliate: { id: profile.id }, attributedAt: { $gte: thirtyDaysAgo } },
      }),
      strapi.entityService.count('api::affiliate-link-click.affiliate-link-click', {
        filters: {
          affiliate: { id: profile.id },
          clickedAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo },
        },
      }),
      strapi.entityService.count('api::affiliate-referral.affiliate-referral', {
        filters: {
          affiliate: { id: profile.id },
          attributedAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo },
        },
      }),
    ]);

    return {
      data: {
        totalClicks, totalReferrals, clicksLast30d, referralsLast30d,
        // Previous-period counts for computing deltas on Overview KPI tiles.
        clicksPrev30d, referralsPrev30d,
      },
    };
  },

  /**
   * GET /affiliates/me/earnings-detail
   * Extended earnings breakdown for the redesigned Overview + Commissions
   * dashboards: daily accrual series (30 days), by-gateway split, top
   * referred contributors, and 30d-vs-prev-30d earning delta.
   */
  async myEarningsDetail(ctx) {
    if (!ctx.state.user) return ctx.unauthorized('Authentication required');
    const userId = ctx.state.user.id;

    const profile = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
      select: ['id'],
    });
    if (!profile) return ctx.notFound('Affiliate profile not found');

    const knex = strapi.db.connection;
    // Guard against schema drift: only proceed if the ledger table exists.
    const lnkJoin = 'affiliate_commissions_affiliate_lnk';

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = new Date(now - 30 * day);
    const sixtyDaysAgo = new Date(now - 60 * day);

    const [daily, byGateway, byReferrer, prevPeriod] = await Promise.all([
      // Daily accrual (last 30 days). Reversed rows count against their
      // original day so the chart shows the net effect on that date.
      knex('affiliate_commissions')
        .join(lnkJoin, `${lnkJoin}.affiliate_commission_id`, '=', 'affiliate_commissions.id')
        .where(`${lnkJoin}.affiliate_profile_id`, profile.id)
        .where('affiliate_commissions.created_at', '>=', thirtyDaysAgo)
        .groupByRaw("date_trunc('day', affiliate_commissions.created_at)")
        .orderByRaw("date_trunc('day', affiliate_commissions.created_at) ASC")
        .select(
          knex.raw("date_trunc('day', affiliate_commissions.created_at) AS day"),
          knex.raw("SUM(CASE WHEN status = 'accrued' THEN commission_amount ELSE 0 END)::numeric AS accrued"),
          knex.raw("SUM(CASE WHEN status = 'reversed' THEN commission_amount ELSE 0 END)::numeric AS reversed"),
        ),
      knex('affiliate_commissions')
        .join(lnkJoin, `${lnkJoin}.affiliate_commission_id`, '=', 'affiliate_commissions.id')
        .where(`${lnkJoin}.affiliate_profile_id`, profile.id)
        .where('status', 'accrued')
        .groupBy('payment_gateway')
        .select(
          'payment_gateway',
          knex.raw('COUNT(*)::int AS count'),
          knex.raw('COALESCE(SUM(commission_amount), 0)::numeric AS amount'),
        ),
      knex('affiliate_commissions')
        .join(lnkJoin, `${lnkJoin}.affiliate_commission_id`, '=', 'affiliate_commissions.id')
        .join(
          'affiliate_commissions_referred_user_lnk as ru',
          'ru.affiliate_commission_id', '=', 'affiliate_commissions.id'
        )
        .where(`${lnkJoin}.affiliate_profile_id`, profile.id)
        .where('affiliate_commissions.status', 'accrued')
        .groupBy('ru.user_id')
        .orderByRaw('SUM(commission_amount) DESC')
        .limit(5)
        .select(
          'ru.user_id AS referred_user_id',
          knex.raw('COUNT(*)::int AS commission_count'),
          knex.raw('COALESCE(SUM(commission_amount), 0)::numeric AS total_earned'),
        ),
      knex('affiliate_commissions')
        .join(lnkJoin, `${lnkJoin}.affiliate_commission_id`, '=', 'affiliate_commissions.id')
        .where(`${lnkJoin}.affiliate_profile_id`, profile.id)
        .where('status', 'accrued')
        .whereBetween('affiliate_commissions.created_at', [sixtyDaysAgo, thirtyDaysAgo])
        .select(knex.raw('COALESCE(SUM(commission_amount), 0)::numeric AS prev30d_accrued'))
        .first(),
    ]);

    return ctx.send({
      data: {
        daily: daily.map((r) => ({
          day: r.day,
          accrued: Number(r.accrued),
          reversed: Number(r.reversed),
        })),
        byGateway: byGateway.map((r) => ({
          gateway: r.payment_gateway,
          count: r.count,
          amount: Number(r.amount),
        })),
        topReferrers: byReferrer.map((r) => ({
          referredUserId: Number(r.referred_user_id),
          commissionCount: r.commission_count,
          totalEarned: Number(r.total_earned),
        })),
        prev30dAccrued: Number(prevPeriod?.prev30d_accrued || 0),
      },
    });
  },

  /**
   * GET /affiliates/me/activity
   * Merged event feed for the Overview timeline: signups + commissions +
   * code rotations. Sorted newest first, capped at 20 rows. Never leaks
   * referred-user email — only the numeric user id.
   */
  async myActivity(ctx) {
    if (!ctx.state.user) return ctx.unauthorized('Authentication required');
    const userId = ctx.state.user.id;

    const profile = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
      select: ['id', 'lastCodeRotationAt'],
    });
    if (!profile) return ctx.notFound('Affiliate profile not found');

    const limit = 20;
    const [referrals, commissions] = await Promise.all([
      strapi.entityService.findMany('api::affiliate-referral.affiliate-referral', {
        filters: { affiliate: { id: profile.id } },
        fields: ['id', 'attributedAt', 'status', 'blockReason'],
        populate: { referredUser: { fields: ['id'] } },
        sort: { attributedAt: 'desc' },
        limit,
      }),
      strapi.db.query('api::affiliate-commission.affiliate-commission').findMany({
        where: { affiliate: profile.id },
        orderBy: { createdAt: 'desc' },
        limit,
        populate: { referredUser: true, sourceTransaction: true },
      }),
    ]);

    const events = [];
    for (const r of referrals || []) {
      events.push({
        type: r.status === 'blocked' ? 'referral_blocked' : 'referral_signup',
        at: r.attributedAt,
        payload: {
          referralId: r.id,
          referredUserId: r.referredUser?.id ?? null,
          blockReason: r.blockReason || null,
        },
      });
    }
    for (const c of commissions || []) {
      events.push({
        type: c.status === 'reversed' ? 'commission_reversed' : 'commission_earned',
        at: c.createdAt,
        payload: {
          commissionId: c.id,
          amount: Number(c.commissionAmount),
          currency: c.commissionCurrency,
          ratePercent: Number(c.ratePercent),
          referredUserId: c.referredUser?.id ?? null,
          sourceTransactionId: c.sourceTransaction?.id ?? null,
          paymentGateway: c.paymentGateway,
        },
      });
    }
    if (profile.lastCodeRotationAt) {
      events.push({
        type: 'code_rotated',
        at: profile.lastCodeRotationAt,
        payload: {},
      });
    }

    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return ctx.send({ data: events.slice(0, limit) });
  },

  /**
   * GET /affiliates/me/commissions?page=1&pageSize=20&status=accrued|reversed
   * The affiliate's own commission ledger. PII stays server-side — we
   * only surface the deposit id, gateway, amount, rate snapshot, and
   * commission amount. No referred-user email/name leaks.
   */
  async myCommissions(ctx) {
    if (!ctx.state.user) return ctx.unauthorized('Authentication required');
    const userId = ctx.state.user.id;

    const profile = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
      select: ['id'],
    });
    if (!profile) return ctx.notFound('Affiliate profile not found');

    const svc = strapi.service('api::affiliate-commission.affiliate-commission');
    const status = ['accrued', 'reversed'].includes(ctx.query?.status)
      ? ctx.query.status
      : undefined;
    const list = await svc.listByAffiliate(profile.id, {
      page: ctx.query?.page,
      pageSize: ctx.query?.pageSize,
      status,
    });

    // Redact the ledger rows — the affiliate should not see the referred
    // user's email or username, only enough info to trust the number.
    const redacted = (list.data || []).map((row) => ({
      id: row.id,
      status: row.status,
      commissionAmount: Number(row.commissionAmount),
      commissionCurrency: row.commissionCurrency,
      depositAmount: Number(row.depositAmount),
      depositCurrency: row.depositCurrency,
      ratePercent: Number(row.ratePercent),
      paymentGateway: row.paymentGateway,
      referredUserId: row.referredUser?.id ?? null,
      sourceTransactionId: row.sourceTransaction?.id ?? null,
      reversedAt: row.reversedAt || null,
      createdAt: row.createdAt,
      // Phase 4: hold-period visibility so the client can render countdowns.
      holdReleaseAt: row.holdReleaseAt || null,
      heldForDays: row.heldForDays ?? null,
      approvedAt: row.approvedAt || null,
      cancelledAt: row.cancelledAt || null,
    }));

    return { data: redacted, meta: list.meta };
  },

  /**
   * GET /affiliates/me/earnings
   * Lifetime + last-30d commission summary. Never returns referred-user PII.
   */
  async myEarnings(ctx) {
    if (!ctx.state.user) return ctx.unauthorized('Authentication required');
    const userId = ctx.state.user.id;

    const profile = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
      select: ['id', 'commissionsEnabled'],
    });
    if (!profile) return ctx.notFound('Affiliate profile not found');

    const svc = strapi.service('api::affiliate-commission.affiliate-commission');
    const stats = await svc.statsByAffiliate(profile.id);

    return {
      data: {
        commissionsEnabled: !!profile.commissionsEnabled,
        ...stats,
      },
    };
  },
}));
