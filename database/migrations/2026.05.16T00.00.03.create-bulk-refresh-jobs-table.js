'use strict';

/**
 * Migration: create the `bulk_refresh_jobs` table.
 *
 * Each bulk-refresh action (export of a domain list, upload of a tool's
 * CSV output, revert of a prior upload) gets one row here. The audit
 * trail in `marketplace_update_histories` links every change to one of
 * these rows via the `bulk_job_id` column (added in the companion
 * migration 2026.05.16T00.00.04...). That gives us:
 *
 *   - A simple list-jobs view (one row per operation, no GROUP BY).
 *   - Per-job summary stats (rows updated / unchanged / errors) without
 *     scanning history every time the dashboard renders.
 *   - One-click revert: pull all history rows for a job, restore the
 *     `from` values in reverse.
 *   - Hash-based duplicate-upload detection: store csv_file_hash on
 *     upload jobs and warn the admin if they re-upload the same bytes
 *     in a short window.
 *
 * Soft FK from history.bulk_job_id → bulk_refresh_jobs.id (no DB
 * constraint — Strapi 5 manages relations through link tables and a
 * raw FK would conflict). The lookup is done in application code.
 */

const TABLE = 'bulk_refresh_jobs';

module.exports = {
  async up(knex) {
    const exists = await knex.schema.hasTable(TABLE);
    if (exists) {
      console.log(`[MIGRATION] ${TABLE} already exists; skipping.`);
      return;
    }

    console.log(`[MIGRATION] Creating ${TABLE} table...`);

    await knex.schema.createTable(TABLE, (t) => {
      t.bigIncrements('id').primary();
      // Strapi 5 conventions: document_id (uuid), timestamps, published_at
      t.string('document_id', 255).notNullable();
      t.string('tool', 32).notNullable();
      t.string('job_type', 32).notNullable();
      t.string('status', 32).notNullable().defaultTo('pending');
      t.integer('row_count').notNullable().defaultTo(0);
      t.integer('updated_count').notNullable().defaultTo(0);
      t.integer('unchanged_count').notNullable().defaultTo(0);
      t.integer('out_of_range_count').notNullable().defaultTo(0);
      t.integer('unmatched_url_count').notNullable().defaultTo(0);
      t.string('csv_file_hash', 128).nullable();
      t.string('csv_filename', 512).nullable();
      t.string('label', 255).nullable();
      t.text('error_message').nullable();
      t.integer('reverted_job_id').nullable(); // points at the job this one reverted
      t.integer('created_by_user_id').nullable();
      t.string('created_by_email', 255).nullable();
      t.timestamp('created_at', { precision: 6 }).nullable();
      t.timestamp('updated_at', { precision: 6 }).nullable();
      t.timestamp('published_at', { precision: 6 }).nullable();
      // Strapi 5's internal audit columns (will be NULL since we create rows
      // via raw query, but the columns must exist for entityService.find to
      // not throw on later reads).
      t.integer('created_by_id').nullable();
      t.integer('updated_by_id').nullable();
      t.string('locale', 32).nullable();
    });

    // Check constraints — Postgres-only, harmless to skip on SQLite tests.
    try {
      await knex.raw(`
        ALTER TABLE ${TABLE}
          ADD CONSTRAINT bulk_refresh_jobs_tool_check
          CHECK (tool IN ('ahrefs','moz','semrush'))
      `);
      await knex.raw(`
        ALTER TABLE ${TABLE}
          ADD CONSTRAINT bulk_refresh_jobs_job_type_check
          CHECK (job_type IN ('export','upload','revert'))
      `);
      await knex.raw(`
        ALTER TABLE ${TABLE}
          ADD CONSTRAINT bulk_refresh_jobs_status_check
          CHECK (status IN ('pending','processing','complete','failed','reverted'))
      `);
    } catch (err) {
      console.warn(`[MIGRATION] CHECK constraints not added: ${err.message}`);
    }

    // Indexes used by the list view, dup-upload detection, and the
    // (future) revert path joining history by bulk_job_id.
    try {
      await knex.raw(`CREATE INDEX IF NOT EXISTS idx_brj_tool_created ON ${TABLE} (tool, created_at DESC)`);
      await knex.raw(`CREATE INDEX IF NOT EXISTS idx_brj_status ON ${TABLE} (status)`);
      await knex.raw(`CREATE INDEX IF NOT EXISTS idx_brj_hash ON ${TABLE} (csv_file_hash)`);
    } catch (err) {
      console.warn(`[MIGRATION] indexes not created: ${err.message}`);
    }

    console.log(`[MIGRATION] ${TABLE} ready.`);
  },

  async down(knex) {
    console.log(`[MIGRATION] Dropping ${TABLE}...`);
    await knex.schema.dropTableIfExists(TABLE);
  },
};
