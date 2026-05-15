'use strict';

/**
 * Migration: partial indexes on the new per-tool refresh timestamps so
 * "oldest cohort" queries (the bulk-refresh export wizard's primary read
 * pattern at 80k+ live sites) hit indexes instead of scanning.
 *
 * Partial WHERE status='active' because:
 *   1. Bulk-refresh only touches live marketplace rows — there's no point
 *      indexing delisted/rejected/draft rows.
 *   2. Keeps the index small (~1k–5k entries vs 80k+) and fast to scan.
 *
 * NULLS FIRST means rows never refreshed sort to the top of an ASC query,
 * which is what the export wizard wants (oldest = highest priority).
 * Idempotent via CREATE INDEX IF NOT EXISTS.
 */

async function createIndexIfNotExists(knex, indexName, sql) {
  try {
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${sql}`);
    console.log(`[MIGRATION] Ensured index ${indexName}`);
  } catch (err) {
    console.warn(`[MIGRATION] Could not create index ${indexName}: ${err.message}`);
  }
}

const INDEXES = [
  {
    name: 'idx_mp_ahrefs_refresh_age',
    sql: "marketplaces (last_ahrefs_refresh_at NULLS FIRST) WHERE status = 'active'",
  },
  {
    name: 'idx_mp_moz_refresh_age',
    sql: "marketplaces (last_moz_refresh_at NULLS FIRST) WHERE status = 'active'",
  },
  {
    name: 'idx_mp_semrush_refresh_age',
    sql: "marketplaces (last_semrush_refresh_at NULLS FIRST) WHERE status = 'active'",
  },
];

module.exports = {
  async up(knex) {
    console.log('[MIGRATION] Adding per-tool refresh-age indexes...');
    for (const { name, sql } of INDEXES) {
      await createIndexIfNotExists(knex, name, sql);
    }
  },

  async down(knex) {
    console.log('[MIGRATION] Dropping per-tool refresh-age indexes...');
    for (const { name } of INDEXES) {
      try {
        await knex.raw(`DROP INDEX IF EXISTS ${name}`);
      } catch (err) {
        console.warn(`[MIGRATION] Could not drop index ${name}: ${err.message}`);
      }
    }
  },
};
