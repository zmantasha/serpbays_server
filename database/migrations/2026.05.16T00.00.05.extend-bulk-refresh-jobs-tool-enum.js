'use strict';

/**
 * Migration: extend bulk_refresh_jobs.tool CHECK constraint to accept
 * 'price' so the same jobs table can track bulk-price-update operations
 * alongside the existing per-tool metric refreshes.
 *
 * 'price' is not a tool in the literal sense — it means "this job
 * applies to pricing fields, not tool-specific metrics". Reusing the
 * same table keeps the audit trail unified and avoids duplicating
 * schema/UI for the same job-tracking concept.
 *
 * Idempotent (drops constraint if present, re-adds with broader list).
 */

const TABLE = 'bulk_refresh_jobs';
const CONSTRAINT = 'bulk_refresh_jobs_tool_check';

module.exports = {
  async up(knex) {
    console.log(`[MIGRATION] Extending ${TABLE}.tool CHECK to include 'price'...`);
    try {
      await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
      await knex.raw(`
        ALTER TABLE ${TABLE}
          ADD CONSTRAINT ${CONSTRAINT}
          CHECK (tool IN ('ahrefs','moz','semrush','price'))
      `);
      console.log(`[MIGRATION] ${CONSTRAINT} now accepts ('ahrefs','moz','semrush','price')`);
    } catch (err) {
      console.warn(`[MIGRATION] Could not update ${CONSTRAINT}: ${err.message}`);
    }
  },

  async down(knex) {
    try {
      await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
      await knex.raw(`
        ALTER TABLE ${TABLE}
          ADD CONSTRAINT ${CONSTRAINT}
          CHECK (tool IN ('ahrefs','moz','semrush'))
      `);
    } catch (err) {
      console.warn(`[MIGRATION] Could not revert ${CONSTRAINT}: ${err.message}`);
    }
  },
};
