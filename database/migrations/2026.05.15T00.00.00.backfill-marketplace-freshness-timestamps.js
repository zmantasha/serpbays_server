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
    // In Strapi 5, db.schema.sync() runs migrations BEFORE syncSchema() adds
    // columns declared in schema.json. On the very first boot after this
    // migration was authored, last_price_update_at / last_metric_update_at do
    // not exist yet, so an unconditional UPDATE crashes bootstrap and PM2
    // crash-loops. Guard each column with an information_schema lookup so the
    // migration is a safe no-op when the column is still pending creation.
    const columns = ['last_price_update_at', 'last_metric_update_at'];

    const { rows: existing } = await knex.raw(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'marketplaces'
          AND column_name = ANY(?)`,
      [columns]
    );
    const present = new Set(existing.map((r) => r.column_name));

    const missing = columns.filter((c) => !present.has(c));
    if (missing.length === columns.length) {
      console.log(
        `[MIGRATION] Skipping backfill: columns ${missing.join(', ')} not yet present on marketplaces. ` +
          `syncSchema() will create them after migrations finish; legacy NULL rows will need a follow-up backfill.`
      );
      return;
    }

    console.log('[MIGRATION] Backfilling marketplace freshness timestamps from createdAt...');

    let priceRows = 0;
    if (present.has('last_price_update_at')) {
      const r = await knex.raw(`
        UPDATE marketplaces
           SET last_price_update_at = created_at
         WHERE last_price_update_at IS NULL
      `);
      priceRows = r.rowCount;
    } else {
      console.log('[MIGRATION] Skipping last_price_update_at backfill: column not yet present.');
    }

    let metricRows = 0;
    if (present.has('last_metric_update_at')) {
      const r = await knex.raw(`
        UPDATE marketplaces
           SET last_metric_update_at = created_at
         WHERE last_metric_update_at IS NULL
      `);
      metricRows = r.rowCount;
    } else {
      console.log('[MIGRATION] Skipping last_metric_update_at backfill: column not yet present.');
    }

    console.log(
      `[MIGRATION] Backfilled ${priceRows} price + ${metricRows} metric timestamps.`
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
