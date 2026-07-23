'use strict';

/**
 * Service for the affiliate-commission-config singleton.
 *
 * `get()` guarantees a row exists — if the admin has never touched Settings,
 * we lazily create the singleton with the built-in defaults (5%, enabled).
 * Callers on the hot path (every deposit) should therefore never see null.
 *
 * `set()` is called from the admin controller and stamps `updatedBy`.
 *
 * Rate values are stored as a decimal percent (5 = 5%). No caching in-process
 * because Strapi's entity layer already caches at the query level for this
 * kind of tiny singleton read, and stale writes here would be a security
 * risk (an admin disabling the program must take effect on the next request).
 */

const CONTENT_TYPE = 'api::affiliate-commission-config.affiliate-commission-config';

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  defaultRatePercent: 5,
});

module.exports = ({ strapi }) => ({
  async get() {
    const existing = await strapi.entityService.findMany(CONTENT_TYPE, {});
    if (existing) return existing;
    return strapi.entityService.create(CONTENT_TYPE, {
      data: { ...DEFAULT_CONFIG },
    });
  },

  async set({ enabled, defaultRatePercent, updatedByUserId }) {
    const current = await this.get();
    const data = {};
    if (typeof enabled === 'boolean') data.enabled = enabled;
    if (typeof defaultRatePercent === 'number' && Number.isFinite(defaultRatePercent)) {
      if (defaultRatePercent < 0 || defaultRatePercent > 100) {
        throw new Error('defaultRatePercent must be between 0 and 100');
      }
      data.defaultRatePercent = defaultRatePercent;
    }
    if (updatedByUserId) data.updatedBy = updatedByUserId;
    return strapi.entityService.update(CONTENT_TYPE, current.id, { data });
  },
});
