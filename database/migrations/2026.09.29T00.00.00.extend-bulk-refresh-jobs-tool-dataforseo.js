'use strict';

/**
 * Migration: allow bulk_refresh_jobs.tool = 'dataforseo' (DataForSEO traffic
 * for sites Ahrefs does not track; see bulk-refresh-profiles 'dataforseo').
 * Idempotent (drops constraint if present, re-adds with the broader list).
 */

const TABLE = 'bulk_refresh_jobs';
const CONSTRAINT = 'bulk_refresh_jobs_tool_check';

module.exports = {
  async up(knex) {
    try {
      await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
      await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (tool IN ('ahrefs','moz','semrush','price','dataforseo'))`);
      console.log(`[MIGRATION] ${CONSTRAINT} now accepts dataforseo`);
    } catch (err) {
      console.warn(`[MIGRATION] Could not update ${CONSTRAINT}: ${err.message}`);
    }
  },

  async down(knex) {
    try {
      await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
      await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (tool IN ('ahrefs','moz','semrush','price'))`);
    } catch (err) {
      console.warn(`[MIGRATION] Could not revert ${CONSTRAINT}: ${err.message}`);
    }
  },
};
