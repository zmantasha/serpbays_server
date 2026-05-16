'use strict';

/**
 * Migration: per-tool freshness tracking on the `marketplaces` table.
 *
 * The existing `last_metric_update_at` advances on any metric change — it
 * can't tell us "when was Ahrefs DR last refreshed for this site?" vs.
 * "when was Moz DA last refreshed?". The bulk-refresh workflow rotates
 * across tools (one month Ahrefs, next month Semrush, etc.), so each tool
 * needs its own freshness clock per site.
 *
 * Columns added:
 *   last_ahrefs_refresh_at   — bumped when Ahrefs-attributed update lands
 *   last_moz_refresh_at      — bumped when Moz-attributed update lands
 *   last_semrush_refresh_at  — bumped when Semrush-attributed update lands
 *   last_ahrefs_export_at    — bumped when admin exports for Ahrefs (intent)
 *   last_moz_export_at       — same for Moz
 *   last_semrush_export_at   — same for Semrush
 *   bulk_refresh_skip_tools  — jsonb array of tool ids the admin has marked
 *                              "skip this tool for this site" so stuck sites
 *                              stop polluting future export batches
 *
 * Idempotent (hasColumn guards). All columns are nullable; existing rows
 * stay NULL until a later migration backfills from last_metric_update_at.
 */

const TIMESTAMP_COLUMNS = [
  'last_ahrefs_refresh_at',
  'last_moz_refresh_at',
  'last_semrush_refresh_at',
  'last_ahrefs_export_at',
  'last_moz_export_at',
  'last_semrush_export_at',
];

module.exports = {
  async up(knex) {
    console.log('[MIGRATION] Adding per-tool freshness columns to marketplaces...');

    for (const col of TIMESTAMP_COLUMNS) {
      const exists = await knex.schema.hasColumn('marketplaces', col);
      if (!exists) {
        await knex.schema.alterTable('marketplaces', (t) => {
          t.timestamp(col, { precision: 6 }).nullable();
        });
        console.log(`[MIGRATION] Added marketplaces.${col}`);
      }
    }

    const skipExists = await knex.schema.hasColumn('marketplaces', 'bulk_refresh_skip_tools');
    if (!skipExists) {
      await knex.schema.alterTable('marketplaces', (t) => {
        t.jsonb('bulk_refresh_skip_tools').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      });
      console.log('[MIGRATION] Added marketplaces.bulk_refresh_skip_tools');
    }
  },

  async down(knex) {
    console.log('[MIGRATION] Reverting per-tool freshness columns on marketplaces...');
    for (const col of [...TIMESTAMP_COLUMNS, 'bulk_refresh_skip_tools']) {
      const exists = await knex.schema.hasColumn('marketplaces', col);
      if (exists) {
        await knex.schema.alterTable('marketplaces', (t) => t.dropColumn(col));
      }
    }
  },
};
