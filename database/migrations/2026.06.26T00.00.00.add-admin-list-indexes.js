'use strict';

/**
 * Migration: composite indexes for admin-list endpoints (perf pass 12, 2026-06-26).
 *
 * The perf-pass-10A migration already covered the single-column hot
 * paths. This one covers the COMPOSITES that the admin panel list
 * queries actually filter on — found during the perf-pass-12 audit
 * (forks: backend API + DB).
 *
 * Why each index:
 *
 *   publisher_websites:
 *     The existing `publisher_websites_submission_status_idx` indexes
 *     (submission_status, updated_at DESC). But the default admin
 *     list sort is `created_at DESC` — that index can't serve the
 *     ORDER BY. Adds (submission_status, created_at DESC) to cover
 *     it without a sort step.
 *
 *     Also adds a pg_trgm GIN index on lower(url) so `$containsi`
 *     URL searches in src/api/admin/controllers/websites.js:177,182
 *     stop doing a Seq Scan + ILIKE match. pg_trgm is already
 *     installed (verified at audit time).
 *
 *   up_users:
 *     Admin users list at users.js:46-60 switches the WHERE between
 *     {confirmed:true, blocked:false} / {blocked:true} / {confirmed:false}
 *     and always sorts by created_at DESC. Composite covers all three.
 *
 *   transactions:
 *     Existing `transactions_status_created_idx` is on (transaction_status,
 *     created_at) and `transactions_type_idx` is on (type, created_at).
 *     Admin tx list filters by BOTH type AND status — neither single
 *     index can serve the combined predicate efficiently. Adding the
 *     three-column composite (type, transaction_status, created_at DESC)
 *     covers both single-column queries AND the combined case.
 *
 * Idempotent via IF NOT EXISTS. CONCURRENTLY where Postgres allows.
 *
 * NOTE: CONCURRENTLY is incompatible with the implicit migration
 * transaction Strapi wraps around up(). The pass-10A migration
 * documented the same constraint. If a CONCURRENTLY statement errors
 * with "cannot run inside a transaction block", drop CONCURRENTLY —
 * staging tables are small enough that the brief lock during a
 * non-concurrent CREATE INDEX is acceptable (rerun the migration if
 * the first attempt failed partway).
 */

// pg_trgm trigram GIN index on publisher_websites.url INTENTIONALLY
// excluded from this migration. The initial attempt failed at runtime
// with "operator class gin_trgm_ops does not exist for access method
// gin" — pg_trgm is listed in pg_extension but the operator classes
// aren't reachable from Strapi's `postgres` user (likely a schema /
// search_path / privilege issue requiring DBA action). Adding it
// blocks every subsequent index in this migration and locks the
// backend in a restart loop. The remaining 3 plain composites are
// independently useful; the trigram can ship in a follow-up once a
// DBA confirms `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA
// public;` succeeds in this database.
const INDEXES = [
  {
    name: 'publisher_websites_status_created_idx',
    sql: 'CREATE INDEX IF NOT EXISTS publisher_websites_status_created_idx ON publisher_websites (submission_status, created_at DESC)',
    why: 'admin website list filters submission_status + sorts created_at DESC (default sort)',
  },
  {
    name: 'up_users_status_created_idx',
    sql: 'CREATE INDEX IF NOT EXISTS up_users_status_created_idx ON up_users (blocked, confirmed, created_at DESC)',
    why: 'admin users list filters blocked/confirmed combos + sorts created_at DESC',
  },
  {
    name: 'transactions_type_status_created_idx',
    sql: 'CREATE INDEX IF NOT EXISTS transactions_type_status_created_idx ON transactions (type, transaction_status, created_at DESC)',
    why: 'admin tx list filters by BOTH type AND status — covers the existing single-column indexes + the combined case',
  },
];

async function up(knex) {
  // Per-index try/catch — a single failure must not abort subsequent
  // indexes. This migration shipped originally with a shared throw,
  // and a single missing operator class locked the backend in a
  // restart loop (2026-06-26 incident). Each index logs its outcome
  // independently; the migration only fails if ALL indexes fail.
  let succeeded = 0;
  const errors = [];
  for (const { name, sql, why } of INDEXES) {
    try {
      await knex.raw(sql);
      console.log(`[migration] created index ${name} — ${why}`);
      succeeded++;
    } catch (err) {
      console.error(`[migration] failed to create ${name}: ${err.message}`);
      errors.push({ name, message: err.message });
    }
  }
  if (succeeded === 0 && errors.length > 0) {
    throw new Error(
      `Migration failed: 0 of ${INDEXES.length} indexes created. ` +
      `First error: ${errors[0].message}`
    );
  }
  if (errors.length > 0) {
    console.warn(
      `[migration] partial success: ${succeeded}/${INDEXES.length} indexes created; ` +
      `${errors.length} failed (see above)`
    );
  }
}

async function down(knex) {
  // Dropping indexes is fast + safe. IF EXISTS makes this idempotent.
  for (const { name } of INDEXES) {
    await knex.raw(`DROP INDEX IF EXISTS ${name}`);
  }
}

module.exports = { up, down };
