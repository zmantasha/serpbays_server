'use strict';

/**
 * Migration: backfill the three per-tool refresh timestamps from the
 * row's existing `last_metric_update_at`.
 *
 * Before this migration the new columns are all NULL on every row. With
 * 80k+ live sites and the bulk-refresh dashboard sorting by oldest
 * refresh, every site would tie at the top until enough Ahrefs/Moz/
 * Semrush refreshes accumulated to discriminate — which would take
 * months.
 *
 * Instead we seed each per-tool clock from the only signal we have:
 * `last_metric_update_at`, which the marketplace lifecycle has been
 * bumping on every tracked-metric change since the freshness system
 * shipped (commit f0dfbe48). Rows that have never had a metric edit
 * (i.e. `last_metric_update_at IS NULL`) stay NULL on all three
 * per-tool columns — those genuinely have no prior signal.
 *
 * Idempotent: only fills the per-tool column when it's currently NULL,
 * so re-running is a no-op once seeded. Down is intentional no-op for
 * the same reason as the earlier freshness backfill (we can't
 * distinguish backfilled values from real refreshes after the fact).
 */

module.exports = {
  async up(knex) {
    console.log('[MIGRATION] Backfilling per-tool refresh timestamps from last_metric_update_at...');

    const ahrefs = await knex.raw(`
      UPDATE marketplaces
         SET last_ahrefs_refresh_at = last_metric_update_at
       WHERE last_ahrefs_refresh_at IS NULL
         AND last_metric_update_at IS NOT NULL
    `);
    const moz = await knex.raw(`
      UPDATE marketplaces
         SET last_moz_refresh_at = last_metric_update_at
       WHERE last_moz_refresh_at IS NULL
         AND last_metric_update_at IS NOT NULL
    `);
    const semrush = await knex.raw(`
      UPDATE marketplaces
         SET last_semrush_refresh_at = last_metric_update_at
       WHERE last_semrush_refresh_at IS NULL
         AND last_metric_update_at IS NOT NULL
    `);

    console.log(
      `[MIGRATION] Backfilled Ahrefs=${ahrefs.rowCount} Moz=${moz.rowCount} Semrush=${semrush.rowCount} rows.`
    );
  },

  async down(/* knex */) {
    console.log(
      '[MIGRATION] Down is a no-op: backfilled per-tool stamps are indistinguishable from real refreshes once a real refresh has happened.'
    );
  },
};
