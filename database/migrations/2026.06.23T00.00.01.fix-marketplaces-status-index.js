'use strict';

/**
 * Perf-pass-10 follow-up: the prior migration tried
 * `marketplaces(submission_status)` but the actual column on this table is
 * `status` (only publisher_websites uses `submission_status`). The first
 * migration logged "column does not exist — continuing" and shipped the
 * other 7 indexes successfully; this one adds the missing index against
 * the correct column.
 *
 * The marketplace public listing filters `WHERE status = 'active'` on
 * nearly every public page load, so this is a hot-path index.
 */

const INDEXES = [
  {
    name: 'marketplaces_status_idx',
    sql: 'CREATE INDEX IF NOT EXISTS marketplaces_status_idx ON marketplaces (status)',
    why: 'public marketplace listing filters status = active',
  },
];

module.exports = {
  async up(knex) {
    for (const { name, sql, why } of INDEXES) {
      try {
        console.log(`[MIGRATION] Creating index ${name} — ${why}`);
        await knex.raw(sql);
        console.log(`[MIGRATION] Ensured ${name}`);
      } catch (err) {
        console.warn(`[MIGRATION] Failed to create ${name}: ${err.message} — continuing`);
      }
    }
  },

  async down(knex) {
    for (const { name } of INDEXES) {
      try {
        await knex.raw(`DROP INDEX IF EXISTS ${name}`);
      } catch (err) {
        console.warn(`[MIGRATION] Failed to drop ${name}: ${err.message} — continuing`);
      }
    }
  },
};
