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
    // The table is a Strapi content-type and is created by syncSchema(), which
    // runs AFTER migrations. On the first boot after this migration was
    // authored the table may not exist yet, which would crash bootstrap with
    // 'relation does not exist' and PM2 crash-loops. Guard with
    // information_schema: if the table is missing, skip cleanly so syncSchema()
    // can create it. The column/index this migration adds are then absent
    // until a follow-up migration re-applies them.
    const { rows: tableRows } = await knex.raw(
      `SELECT 1
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ?
        LIMIT 1`,
      [TABLE]
    );
    if (tableRows.length === 0) {
      console.log(
        `[MIGRATION] Skipping ${TABLE}.${COLUMN} add: table not yet present. ` +
          `syncSchema() will create the table after migrations finish; a follow-up migration will need to add the column.`
      );
      return;
    }

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
