'use strict';

/**
 * Admin controller for the affiliate-commission-config singleton.
 * Gated by global::is-admin + global::admin-jwt-auth in the route.
 */

module.exports = {
  async get(ctx) {
    try {
      const config = await strapi.service(
        'api::affiliate-commission-config.affiliate-commission-config'
      ).get();
      return ctx.send({
        data: {
          id: config.id,
          enabled: !!config.enabled,
          defaultRatePercent: Number(config.defaultRatePercent),
          holdPeriodDays: Number(config.holdPeriodDays ?? 15),
          depositRetentionThresholdPct: Number(config.depositRetentionThresholdPct ?? 5),
          updatedAt: config.updatedAt,
        },
      });
    } catch (err) {
      strapi.log.error(`[ADMIN AFFILIATE COMMISSION CONFIG] get failed: ${err.message}`);
      return ctx.internalServerError('Failed to load affiliate commission config');
    }
  },

  async update(ctx) {
    try {
      const adminUser = ctx.state.user;
      const body = ctx.request.body || {};
      const patch = {};

      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

      if (body.defaultRatePercent !== undefined) {
        const rate = Number(body.defaultRatePercent);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
          return ctx.badRequest('defaultRatePercent must be a number between 0 and 100');
        }
        patch.defaultRatePercent = rate;
      }

      if (body.holdPeriodDays !== undefined && body.holdPeriodDays !== null) {
        const n = Number(body.holdPeriodDays);
        if (!Number.isInteger(n) || n < 0 || n > 365) {
          return ctx.badRequest('holdPeriodDays must be an integer between 0 and 365');
        }
        patch.holdPeriodDays = n;
      }

      if (body.depositRetentionThresholdPct !== undefined && body.depositRetentionThresholdPct !== null) {
        const n = Number(body.depositRetentionThresholdPct);
        if (!Number.isInteger(n) || n < 0 || n > 100) {
          return ctx.badRequest('depositRetentionThresholdPct must be an integer between 0 and 100');
        }
        patch.depositRetentionThresholdPct = n;
      }

      if (
        patch.enabled === undefined &&
        patch.defaultRatePercent === undefined &&
        patch.holdPeriodDays === undefined &&
        patch.depositRetentionThresholdPct === undefined
      ) {
        return ctx.badRequest('Provide at least one of {enabled, defaultRatePercent, holdPeriodDays, depositRetentionThresholdPct}');
      }

      const updated = await strapi.service(
        'api::affiliate-commission-config.affiliate-commission-config'
      ).set({
        enabled: patch.enabled,
        defaultRatePercent: patch.defaultRatePercent,
        holdPeriodDays: patch.holdPeriodDays,
        depositRetentionThresholdPct: patch.depositRetentionThresholdPct,
      });

      try {
        await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
          data: {
            adminUser: adminUser?.id,
            action: 'affiliate_commission_config_update',
            details: patch,
            ipAddress: ctx.request.ip,
            userAgent: ctx.request.headers['user-agent'],
          },
        });
      } catch (auditErr) {
        strapi.log.warn(`[ADMIN AFFILIATE COMMISSION CONFIG] audit-log failed: ${auditErr.message}`);
      }

      return ctx.send({
        data: {
          id: updated.id,
          enabled: !!updated.enabled,
          defaultRatePercent: Number(updated.defaultRatePercent),
          holdPeriodDays: Number(updated.holdPeriodDays ?? 15),
          depositRetentionThresholdPct: Number(updated.depositRetentionThresholdPct ?? 5),
          updatedAt: updated.updatedAt,
        },
      });
    } catch (err) {
      strapi.log.error(`[ADMIN AFFILIATE COMMISSION CONFIG] update failed: ${err.message}`);
      return ctx.internalServerError('Failed to update affiliate commission config');
    }
  },
};
