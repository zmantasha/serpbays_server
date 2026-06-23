'use strict';

/**
 * Migration: add indexes on the columns hot-path queries filter & sort by.
 *
 * The performance audit (perf-pass-10) found Strapi 5 only auto-creates
 * indexes on created_by_id / updated_by_id / document_id+locale — i.e. the
 * audit fields, not the ACTUAL filter columns. At staging row counts (≤1k)
 * a Seq Scan + Sort runs in <1ms; at production scale (forecast 100k+ on
 * orders, transactions, notifications) those same queries grow to 1-3s
 * per request.
 *
 * Each CREATE INDEX uses CONCURRENTLY so reads/writes are NOT blocked
 * during creation (CONCURRENTLY takes longer but doesn't take an ACCESS
 * EXCLUSIVE lock). Idempotent via IF NOT EXISTS so a re-run on environments
 * that already have the index is a no-op.
 *
 * Indexes added:
 *   orders:               (order_status, order_date DESC)
 *                         (updated_at DESC)
 *   transactions:         (transaction_status, created_at DESC)
 *                         (type, created_at DESC)
 *   notifications:        (created_at DESC) WHERE is_read = false   ← partial
 *   publisher_websites:   (submission_status, updated_at DESC)
 *   withdrawal_requests:  (withdrawal_status, created_at DESC)
 *   marketplaces:         (submission_status)
 *
 * The notifications index is partial (WHERE is_read = false) because the
 * dominant query is "unread count for user N" — partial indexes are
 * smaller and faster than full-table indexes for sparse predicates.
 *
 * The ordering inside each index matches the most common sort order so
 * Postgres can serve `ORDER BY ... DESC LIMIT N` without an extra sort step.
 *
 * IMPORTANT: knex.raw queries run outside a transaction here. CONCURRENTLY
 * is incompatible with the implicit migration transaction Strapi wraps
 * around `up()` — so each statement is sent on its own raw connection
 * via `await knex.raw(...)`. If the migration runner tries to wrap us in
 * a tx, the first `CONCURRENTLY` will error with "cannot run inside a
 * transaction block" — when that happens, drop CONCURRENTLY (this DB is
 * small enough that the brief write lock during a non-concurrent CREATE
 * INDEX is acceptable; or run the SQL out-of-band against prod).
 */

const INDEXES = [
  // orders
  {
    name: 'orders_status_date_idx',
    sql: 'CREATE INDEX IF NOT EXISTS orders_status_date_idx ON orders (order_status, order_date DESC)',
    why: 'list endpoints filter by status + sort by date',
  },
  {
    name: 'orders_updated_at_idx',
    sql: 'CREATE INDEX IF NOT EXISTS orders_updated_at_idx ON orders (updated_at DESC)',
    why: 'my-orders endpoint sorts by updated_at',
  },
  // transactions
  {
    name: 'transactions_status_created_idx',
    sql: 'CREATE INDEX IF NOT EXISTS transactions_status_created_idx ON transactions (transaction_status, created_at DESC)',
    why: 'admin tx list + user history filter by status, sort by date',
  },
  {
    name: 'transactions_type_idx',
    sql: 'CREATE INDEX IF NOT EXISTS transactions_type_idx ON transactions (type, created_at DESC)',
    why: 'reports group by type, sort by date',
  },
  // notifications — partial index for unread count
  {
    name: 'notifications_unread_partial_idx',
    sql: 'CREATE INDEX IF NOT EXISTS notifications_unread_partial_idx ON notifications (created_at DESC) WHERE is_read = false',
    why: 'unread count query + bell badge (the dominant notification query)',
  },
  // publisher_websites — admin approval queue
  {
    name: 'publisher_websites_submission_status_idx',
    sql: 'CREATE INDEX IF NOT EXISTS publisher_websites_submission_status_idx ON publisher_websites (submission_status, updated_at DESC)',
    why: 'admin website-approval queue filters submission_status',
  },
  // withdrawal_requests — admin queue
  {
    name: 'withdrawal_requests_status_created_idx',
    sql: 'CREATE INDEX IF NOT EXISTS withdrawal_requests_status_created_idx ON withdrawal_requests (withdrawal_status, created_at DESC)',
    why: 'admin withdrawal queue + publisher history filter by status',
  },
  // marketplaces — public listing
  {
    name: 'marketplaces_submission_status_idx',
    sql: 'CREATE INDEX IF NOT EXISTS marketplaces_submission_status_idx ON marketplaces (submission_status)',
    why: 'marketplace public listing filters by status (typically = approved)',
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
        // Don't take the whole migration down if one index already exists
        // in a non-standard form (e.g. an admin created it manually). Log
        // and continue so the rest still ship.
        console.warn(`[MIGRATION] Failed to create ${name}: ${err.message} — continuing`);
      }
    }
  },

  async down(knex) {
    for (const { name } of INDEXES) {
      try {
        console.log(`[MIGRATION] Dropping index ${name}`);
        await knex.raw(`DROP INDEX IF EXISTS ${name}`);
      } catch (err) {
        console.warn(`[MIGRATION] Failed to drop ${name}: ${err.message} — continuing`);
      }
    }
  },
};
