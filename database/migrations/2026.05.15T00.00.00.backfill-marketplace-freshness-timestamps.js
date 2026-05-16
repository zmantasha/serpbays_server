'use strict';

/**
 * Migration: Backfill lastPriceUpdateAt / lastMetricUpdateAt on existing
 * marketplace rows that predate the freshness tracking system (commit
 * f0dfbe48, 2026-05-14).
 *
 * Before that commit, listings had no timestamp for their last price/metric
 * change, so the columns were NULL on every row created earlier. The
 * marketplace lifecycle now seeds these columns on create and stamps them on
 * tracked-field updates, but legacy NULL rows remain — which makes the
 * "Stale price > N days" filter on the admin Websites page surface only
 * legacy rows (NULL is treated as infinitely old) until enough fresh rows
 * accumulate >= N days of staleness.
 *
 * We backfill NULL timestamps from the row's createdAt — i.e. assume the
 * price/metrics are as old as the listing itself. That's the same default
 * the beforeCreate hook applies to new rows, so the data is internally
 * consistent and the filter immediately returns intuitive results.
 *
 * Idempotent: only touches rows where the target column is still NULL.
 */

module.exports = {
  async up(knex) {
    console.log('[MIGRATION] Backfilling marketplace freshness timestamps from createdAt...');

    const priceResult = await knex.raw(`
      UPDATE marketplaces
         SET last_price_update_at = created_at
       WHERE last_price_update_at IS NULL
    `);

    const metricResult = await knex.raw(`
      UPDATE marketplaces
         SET last_metric_update_at = created_at
       WHERE last_metric_update_at IS NULL
    `);

    console.log(
      `[MIGRATION] Backfilled ${priceResult.rowCount} price + ${metricResult.rowCount} metric timestamps.`
    );
  },

  async down(/* knex */) {
    // Intentional no-op. Once backfilled we can't distinguish original NULLs
    // from rows whose lastPriceUpdateAt legitimately equals createdAt (the
    // beforeCreate default for new rows). Restoring NULLs would corrupt those.
    console.log(
      '[MIGRATION] Down is a no-op: backfilled timestamps are indistinguishable from beforeCreate defaults.'
    );
  },
};
