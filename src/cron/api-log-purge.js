'use strict';

/**
 * API Log Retention Cron
 *
 * Deletes api-log rows older than `API_LOGGER_RETENTION_DAYS` (default 30).
 * Runs daily at 03:17 to avoid colliding with the 04:00 order cancellation
 * job. The cutoff is recomputed each run so a config change takes effect
 * immediately.
 */

const RETENTION_DAYS = parseInt(process.env.API_LOGGER_RETENTION_DAYS || '30', 10);

module.exports = {
  '17 3 * * *': async ({ strapi }) => {
    const days = Number.isFinite(RETENTION_DAYS) && RETENTION_DAYS > 0 ? RETENTION_DAYS : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    try {
      const deleted = await strapi.db.query('api::api-log.api-log').deleteMany({
        where: { createdAt: { $lt: cutoff } },
      });
      const count = (deleted && (deleted.count ?? deleted)) || 0;
      strapi.log.info(`[api-log-purge] Deleted ${count} api-log rows older than ${days} days (< ${cutoff.toISOString()})`);
    } catch (err) {
      strapi.log.error(`[api-log-purge] Failed to purge old api-log rows: ${err.message}`);
    }
  },
};
