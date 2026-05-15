'use strict';

/**
 * Migration: link `marketplace_update_histories` rows to a bulk-refresh
 * job by adding a nullable `bulk_job_id` column with an index.
 *
 * Strapi enforces the `source` enum at the application layer (no DB
 * CHECK constraint exists on the column — verified at migration time),
 * so the new source values (bulk-ahrefs, bulk-moz, bulk-semrush,
 * admin-revert) are added via the schema.json edit alone. This
 * migration only handles the structural column add.
 *
 * Soft FK to bulk_refresh_jobs(id). Not a DB constraint — Strapi 5's
 * relation handling would conflict with manually-added FKs, and the
 * join is done in app code anyway.
 *
 * Idempotent (hasColumn guard).
 */

const TABLE = 'marketplace_update_histories';
const COLUMN = 'bulk_job_id';
const INDEX = 'idx_muh_bulk_job_id';

module.exports = {
  async up(knex) {
    const exists = await knex.schema.hasColumn(TABLE, COLUMN);
    if (!exists) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.integer(COLUMN).nullable();
      });
      console.log(`[MIGRATION] Added ${TABLE}.${COLUMN}`);
    }

    try {
      await knex.raw(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} (${COLUMN}) WHERE ${COLUMN} IS NOT NULL`);
      console.log(`[MIGRATION] Ensured index ${INDEX}`);
    } catch (err) {
      console.warn(`[MIGRATION] Could not create index ${INDEX}: ${err.message}`);
    }
  },

  async down(knex) {
    try {
      await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
    } catch (err) {
      console.warn(`[MIGRATION] Could not drop index ${INDEX}: ${err.message}`);
    }
    const exists = await knex.schema.hasColumn(TABLE, COLUMN);
    if (exists) {
      await knex.schema.alterTable(TABLE, (t) => t.dropColumn(COLUMN));
    }
  },
};
