'use strict';

/**
 * Admin controller for the affiliate program.
 *
 * All routes gated by `global::is-admin` + `global::admin-jwt-auth`.
 * See src/api/admin/routes/affiliates.js.
 *
 * Handlers here return richer data than the user-facing controller —
 * admin can see who is behind a code (email, name), disable reasons,
 * fraud signals, etc. Still respects the schema's `privateAttributes` for
 * `disabledReason` / `adminNotes` — those are text fields we allow admins
 * to see but the Strapi sanitizer strips for anyone else who would query.
 */

const { generateUniqueCode } = require('../../../utils/referral-code');

module.exports = {
  /**
   * GET /admin/affiliates
   * Paginated list. Supports optional `?status=active|disabled|terminated`
   * and `?search=<user email or referralCode fragment>`. pageSize capped
   * at 200 for admin ops (higher than user list — pass-10 pattern).
   */
  async find(ctx) {
    const rawSize = Number.parseInt(ctx.query?.pageSize, 10);
    const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(rawSize, 200) : 50;
    const rawPage = Number.parseInt(ctx.query?.page, 10);
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

    const filters = {};
    if (typeof ctx.query?.status === 'string') {
      if (['active', 'disabled', 'terminated'].includes(ctx.query.status)) {
        filters.status = ctx.query.status;
      }
    }
    if (typeof ctx.query?.search === 'string' && ctx.query.search.trim().length) {
      const q = ctx.query.search.trim();
      filters.$or = [
        { referralCode: { $containsi: q } },
        { user: { email: { $containsi: q } } },
        { user: { username: { $containsi: q } } },
      ];
    }

    const [rows, total] = await Promise.all([
      strapi.entityService.findMany('api::affiliate-profile.affiliate-profile', {
        filters,
        fields: ['id', 'referralCode', 'status', 'disabledAt', 'lastCodeRotationAt', 'createdAt', 'updatedAt'],
        populate: {
          user:        { fields: ['id', 'email', 'username', 'firstName', 'lastName'] },
          disabledBy:  { fields: ['id', 'email'] },
        },
        sort: { createdAt: 'desc' },
        limit: pageSize,
        start: (page - 1) * pageSize,
      }),
      strapi.entityService.count('api::affiliate-profile.affiliate-profile', { filters }),
    ]);

    // Bulk-fetch pending_review referral counts for the page's affiliates in
    // ONE query — avoids N round-trips per row. Keys the map by profile id so
    // rows without any pending_review referrals default to 0 client-side.
    const pageAffiliateIds = rows.map((r) => r.id).filter(Boolean);
    let pendingReviewByAffiliate = new Map();
    if (pageAffiliateIds.length > 0) {
      const knex = strapi.db.connection;
      const agg = await knex('affiliate_referrals')
        .join(
          'affiliate_referrals_affiliate_lnk as lnk',
          'lnk.affiliate_referral_id', '=', 'affiliate_referrals.id',
        )
        .whereIn('lnk.affiliate_profile_id', pageAffiliateIds)
        .where('affiliate_referrals.status', 'pending_review')
        .groupBy('lnk.affiliate_profile_id')
        .select(
          'lnk.affiliate_profile_id AS affiliate_profile_id',
          knex.raw('COUNT(*)::int AS pending_review_count'),
        );
      pendingReviewByAffiliate = new Map(
        agg.map((r) => [Number(r.affiliate_profile_id), Number(r.pending_review_count)]),
      );
    }

    const shaped = rows.map((r) => ({
      ...r,
      pendingReviewCount: pendingReviewByAffiliate.get(r.id) || 0,
    }));

    return {
      data: shaped,
      meta: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) },
    };
  },

  /**
   * GET /admin/affiliates/:id
   * Detail view for one affiliate. Includes derived counts (clicks / referrals)
   * so the admin doesn't need N round-trips to build a profile page.
   */
  async findOne(ctx) {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) return ctx.notFound('Affiliate not found');

    const row = await strapi.entityService.findOne('api::affiliate-profile.affiliate-profile', id, {
      populate: {
        user:       { fields: ['id', 'email', 'username', 'firstName', 'lastName', 'createdAt'] },
        disabledBy: { fields: ['id', 'email'] },
      },
    });
    if (!row) return ctx.notFound('Affiliate not found');

    const [totalClicks, totalReferrals, blockedReferrals] = await Promise.all([
      strapi.entityService.count('api::affiliate-link-click.affiliate-link-click', {
        filters: { affiliate: { id } },
      }),
      strapi.entityService.count('api::affiliate-referral.affiliate-referral', {
        filters: { affiliate: { id } },
      }),
      strapi.entityService.count('api::affiliate-referral.affiliate-referral', {
        filters: { affiliate: { id }, status: 'blocked' },
      }),
    ]);

    return {
      data: { ...row, stats: { totalClicks, totalReferrals, blockedReferrals } },
    };
  },

  /**
   * PUT /admin/affiliates/:id/disable
   * body: { reason?: string }
   * Sets status='disabled'. New clicks against this code will NOT resolve
   * (returns 204 like an invalid code). Existing referrals are preserved.
   */
  async disable(ctx) {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) return ctx.notFound('Affiliate not found');

    const admin = ctx.state.user;
    if (!admin) return ctx.unauthorized();

    const reason = typeof ctx.request?.body?.reason === 'string' ? ctx.request.body.reason.trim().slice(0, 2000) : null;

    const row = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({ where: { id } });
    if (!row) return ctx.notFound('Affiliate not found');
    if (row.status === 'terminated') return ctx.badRequest('Cannot disable a terminated affiliate.');

    const updated = await strapi.entityService.update('api::affiliate-profile.affiliate-profile', id, {
      data: {
        status: 'disabled',
        disabledAt: new Date(),
        disabledBy: admin.id,
        disabledReason: reason,
      },
    });
    strapi.log.info(`[admin/affiliates] user=${admin.id} DISABLED affiliate=${id} reason=${reason || '(none)'}`);
    return { data: updated };
  },

  /**
   * PUT /admin/affiliates/:id/enable
   * Sets status='active'. Only allowed from status='disabled' — terminated
   * is permanent.
   */
  async enable(ctx) {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) return ctx.notFound('Affiliate not found');
    const admin = ctx.state.user;
    if (!admin) return ctx.unauthorized();

    const row = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({ where: { id } });
    if (!row) return ctx.notFound('Affiliate not found');
    if (row.status === 'active') return { data: row }; // idempotent
    if (row.status === 'terminated') return ctx.badRequest('Cannot re-enable a terminated affiliate.');

    const updated = await strapi.entityService.update('api::affiliate-profile.affiliate-profile', id, {
      data: {
        status: 'active',
        disabledAt: null,
        disabledBy: null,
        disabledReason: null,
      },
    });
    strapi.log.info(`[admin/affiliates] user=${admin.id} ENABLED affiliate=${id}`);
    return { data: updated };
  },

  /**
   * PUT /admin/affiliates/:id/regenerate-code
   * Rotates the affiliate's referralCode. No cooldown check — admin
   * privilege overrides the self-service throttle.
   */
  async regenerateCode(ctx) {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) return ctx.notFound('Affiliate not found');
    const admin = ctx.state.user;
    if (!admin) return ctx.unauthorized();

    const row = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({ where: { id } });
    if (!row) return ctx.notFound('Affiliate not found');
    if (row.status === 'terminated') return ctx.badRequest('Cannot rotate a terminated affiliate.');

    const newCode = await generateUniqueCode(strapi);
    const updated = await strapi.entityService.update('api::affiliate-profile.affiliate-profile', id, {
      data: {
        referralCode: newCode,
        lastCodeRotationAt: new Date(),
      },
    });
    strapi.log.info(`[admin/affiliates] user=${admin.id} rotated code for affiliate=${id}`);
    return { data: updated };
  },

  /**
   * PUT /admin/affiliates/:id/terminate
   * body: { reason?: string }
   * Permanent kill switch. Cannot be re-enabled. Existing referrals remain
   * for audit; new clicks are ignored; self-service endpoints return
   * "affiliate not active" style errors.
   */
  async terminate(ctx) {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) return ctx.notFound('Affiliate not found');
    const admin = ctx.state.user;
    if (!admin) return ctx.unauthorized();

    const reason = typeof ctx.request?.body?.reason === 'string' ? ctx.request.body.reason.trim().slice(0, 2000) : null;

    const row = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({ where: { id } });
    if (!row) return ctx.notFound('Affiliate not found');

    const updated = await strapi.entityService.update('api::affiliate-profile.affiliate-profile', id, {
      data: {
        status: 'terminated',
        disabledAt: new Date(),
        disabledBy: admin.id,
        disabledReason: reason,
      },
    });
    strapi.log.warn(`[admin/affiliates] user=${admin.id} TERMINATED affiliate=${id} reason=${reason || '(none)'}`);
    return { data: updated };
  },

  /**
   * GET /admin/affiliates/:id/referrals
   * The full referral list under an affiliate — with the referred user's
   * PII (email, username). Admin-only visibility.
   */
  async referrals(ctx) {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) return ctx.notFound('Affiliate not found');

    const rawSize = Number.parseInt(ctx.query?.pageSize, 10);
    const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(rawSize, 200) : 50;
    const rawPage = Number.parseInt(ctx.query?.page, 10);
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

    const filters = { affiliate: { id } };
    if (typeof ctx.query?.status === 'string' && ['active', 'blocked', 'churned'].includes(ctx.query.status)) {
      filters.status = ctx.query.status;
    }

    const [rows, total] = await Promise.all([
      strapi.entityService.findMany('api::affiliate-referral.affiliate-referral', {
        filters,
        populate: {
          referredUser:      { fields: ['id', 'email', 'username', 'firstName', 'lastName', 'createdAt'] },
          referralLinkClick: { fields: ['id', 'clickedAt', 'country', 'utmSource', 'utmCampaign'] },
        },
        sort: { attributedAt: 'desc' },
        limit: pageSize,
        start: (page - 1) * pageSize,
      }),
      strapi.entityService.count('api::affiliate-referral.affiliate-referral', { filters }),
    ]);

    return {
      data: rows,
      meta: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) },
    };
  },

  // ── Per-affiliate commission controls ─────────────────────────────────
  /**
   * PUT /admin/affiliates/:id/commissions/disable
   * Body: { reason?: string }
   * Stops NEW commissions accruing for this affiliate. Previously accrued
   * rows remain intact + visible on both dashboards.
   */
  async disableCommissions(ctx) {
    const id = Number(ctx.params?.id);
    if (!Number.isFinite(id) || id <= 0) return ctx.badRequest('Invalid affiliate id');
    const adminUser = ctx.state.user;
    const reason = String(ctx.request.body?.reason || '').trim().slice(0, 2000);

    const existing = await strapi.entityService.findOne(
      'api::affiliate-profile.affiliate-profile',
      id,
      { fields: ['id', 'commissionsEnabled'] }
    );
    if (!existing) return ctx.notFound('Affiliate not found');
    if (existing.commissionsEnabled === false) {
      return ctx.send({ data: existing, alreadyDisabled: true });
    }

    const updated = await strapi.entityService.update(
      'api::affiliate-profile.affiliate-profile',
      id,
      {
        data: {
          commissionsEnabled: false,
          commissionsDisabledAt: new Date(),
          commissionsDisabledBy: adminUser?.id,
          commissionsDisabledReason: reason || null,
        },
      }
    );

    try {
      await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
        data: {
          adminUser: adminUser?.id,
          action: 'affiliate_commissions_disable',
          details: { affiliateProfileId: id, reason: reason || null },
          ipAddress: ctx.request.ip,
          userAgent: ctx.request.headers['user-agent'],
        },
      });
    } catch (_) { /* best-effort */ }

    return ctx.send({ data: updated });
  },

  /**
   * PUT /admin/affiliates/:id/commissions/enable
   * Re-enables commission accrual for this affiliate.
   */
  async enableCommissions(ctx) {
    const id = Number(ctx.params?.id);
    if (!Number.isFinite(id) || id <= 0) return ctx.badRequest('Invalid affiliate id');
    const adminUser = ctx.state.user;

    const existing = await strapi.entityService.findOne(
      'api::affiliate-profile.affiliate-profile',
      id,
      { fields: ['id', 'commissionsEnabled', 'status'] }
    );
    if (!existing) return ctx.notFound('Affiliate not found');
    if (existing.status === 'terminated') {
      return ctx.badRequest('Cannot enable commissions on a terminated affiliate');
    }
    if (existing.commissionsEnabled === true) {
      return ctx.send({ data: existing, alreadyEnabled: true });
    }

    const updated = await strapi.entityService.update(
      'api::affiliate-profile.affiliate-profile',
      id,
      {
        data: {
          commissionsEnabled: true,
          commissionsDisabledAt: null,
          commissionsDisabledBy: null,
          commissionsDisabledReason: null,
        },
      }
    );

    try {
      await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
        data: {
          adminUser: adminUser?.id,
          action: 'affiliate_commissions_enable',
          details: { affiliateProfileId: id },
          ipAddress: ctx.request.ip,
          userAgent: ctx.request.headers['user-agent'],
        },
      });
    } catch (_) { /* best-effort */ }

    return ctx.send({ data: updated });
  },

  /**
   * GET /admin/affiliates/:id/commissions?page=1&pageSize=20&status=accrued|reversed
   * Paginated list of commission ledger rows + summary stats.
   */
  async commissions(ctx) {
    const id = Number(ctx.params?.id);
    if (!Number.isFinite(id) || id <= 0) return ctx.badRequest('Invalid affiliate id');

    const exists = await strapi.entityService.findOne(
      'api::affiliate-profile.affiliate-profile', id, { fields: ['id'] }
    );
    if (!exists) return ctx.notFound('Affiliate not found');

    const svc = strapi.service('api::affiliate-commission.affiliate-commission');
    const [list, stats] = await Promise.all([
      svc.listByAffiliate(id, {
        page: ctx.query?.page,
        pageSize: ctx.query?.pageSize,
        status: ['accrued', 'reversed'].includes(ctx.query?.status) ? ctx.query.status : undefined,
      }),
      svc.statsByAffiliate(id),
    ]);

    return ctx.send({ data: list.data, meta: list.meta, stats });
  },

  /**
   * PUT /admin/affiliates/:id/referrals/:referralId/status
   * Body: { status: 'active' | 'pending_review' | 'blocked' | 'churned', reason?: string }
   *
   * The admin's review action on a soft-flagged (or manually-flagged)
   * referral. Typical transitions:
   *   pending_review → active   (false positive on shared network etc.)
   *   pending_review → blocked  (confirmed suspicious pattern)
   *   blocked        → active   (unblock — legit referral was hard-blocked)
   *   active         → blocked  (retroactive block after finding fraud)
   *
   * Commission accrual is gated on referral.status='active' in the
   * commission engine — flipping to active does NOT retroactively
   * generate commissions for past deposits; a separate backfill script
   * handles that if needed.
   */
  async setReferralStatus(ctx) {
    const affiliateId = Number(ctx.params?.id);
    const referralId = Number(ctx.params?.referralId);
    if (!Number.isFinite(affiliateId) || affiliateId <= 0) {
      return ctx.badRequest('Invalid affiliate id');
    }
    if (!Number.isFinite(referralId) || referralId <= 0) {
      return ctx.badRequest('Invalid referral id');
    }

    const body = ctx.request.body || {};
    const nextStatus = String(body.status || '').trim();
    const ALLOWED = ['active', 'pending_review', 'blocked', 'churned'];
    if (!ALLOWED.includes(nextStatus)) {
      return ctx.badRequest(`status must be one of ${ALLOWED.join(', ')}`);
    }
    const reason = typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 2000)
      : null;

    // Confirm the referral belongs to this affiliate (defense-in-depth
    // against a stale URL that mismatches the id pair).
    const existing = await strapi.db.query('api::affiliate-referral.affiliate-referral').findOne({
      where: { id: referralId },
      populate: { affiliate: true },
    });
    if (!existing) return ctx.notFound('Referral not found');
    if (existing.affiliate?.id !== affiliateId) {
      return ctx.badRequest('Referral does not belong to this affiliate');
    }

    if (existing.status === nextStatus) {
      return ctx.send({ data: existing, unchanged: true });
    }

    const admin = ctx.state.user;
    const timestamp = new Date().toISOString();
    const historyLine = `[${timestamp}] admin=${admin?.username || admin?.id} ${existing.status} -> ${nextStatus}${reason ? ` — ${reason}` : ''}`;
    const nextAdminNotes = existing.adminNotes
      ? `${existing.adminNotes}\n${historyLine}`
      : historyLine;

    // Clear blockReason when moving to 'active' — the referral is no
    // longer flagged. Keep it when moving to/staying in a non-active
    // state so history is preserved.
    const patch = {
      status: nextStatus,
      adminNotes: nextAdminNotes,
    };
    if (nextStatus === 'active') {
      patch.blockReason = null;
    } else if (nextStatus === 'blocked' && existing.blockReason == null) {
      // Manually-confirmed block with no earlier auto-flag reason.
      patch.blockReason = 'admin_manual';
    }

    const updated = await strapi.entityService.update(
      'api::affiliate-referral.affiliate-referral',
      referralId,
      { data: patch },
    );

    try {
      await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
        data: {
          adminUser: admin?.id,
          action: 'affiliate_referral_status_change',
          details: {
            affiliateId,
            referralId,
            prevStatus: existing.status,
            nextStatus,
            reason: reason || null,
          },
          ipAddress: ctx.request.ip,
          userAgent: ctx.request.headers['user-agent'],
        },
      });
    } catch (_) { /* best-effort */ }

    strapi.log.info(
      `[admin/affiliates] user=${admin?.id} referral=${referralId} ${existing.status} -> ${nextStatus} reason=${reason || '(none)'}`,
    );

    return ctx.send({ data: updated });
  },
};
