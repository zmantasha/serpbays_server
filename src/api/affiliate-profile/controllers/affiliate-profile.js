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
      fields: ['id', 'attributedAt', 'status'],
      populate: { referredUser: { fields: ['id'] } },  // id-only — no PII
      sort: { attributedAt: 'desc' },
      limit: pageSize,
      start: (page - 1) * pageSize,
    });

    const shaped = (rows || []).map((r) => ({
      id: r.id,
      attributedAt: r.attributedAt,
      status: r.status,
      referredUserId: r.referredUser?.id || null,  // just the numeric id
    }));

    return {
      data: shaped,
      meta: { page, pageSize, count: shaped.length },
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

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [totalClicks, totalReferrals, clicksLast30d, referralsLast30d] = await Promise.all([
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
    ]);

    return {
      data: { totalClicks, totalReferrals, clicksLast30d, referralsLast30d },
    };
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
