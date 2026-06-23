'use strict';

/**
 * Perf-pass-10 retry: the original 2026.06.23T00.00.00.add-hot-query-indexes
 * migration was logged as "ensured" for 7 indexes, but only 1 actually
 * persisted. Root cause: Strapi wraps each migration's `up()` in a single
 * transaction; the 8th CREATE INDEX tried to reference a non-existent
 * column on marketplaces (`submission_status` — the actual column is
 * `status`). Once that ERROR fired inside the transaction, every prior
 * statement in the same tx was rolled back at COMMIT time, even though
 * our try/catch caught the JS error.
 *
 * This migration re-creates the 7 dropped indexes WITHOUT a failing
 * statement, so Strapi's wrapping tx commits cleanly.
 *
 * Idempotent via IF NOT EXISTS — re-runnable on any environment.
 */

const INDEXES = [
  {
    name: 'orders_status_date_idx',
    sql: 'CREATE INDEX IF NOT EXISTS orders_status_date_idx ON orders (order_status, order_date DESC)',
  },
  {
    name: 'orders_updated_at_idx',
    sql: 'CREATE INDEX IF NOT EXISTS orders_updated_at_idx ON orders (updated_at DESC)',
  },
  {
    name: 'transactions_status_created_idx',
    sql: 'CREATE INDEX IF NOT EXISTS transactions_status_created_idx ON transactions (transaction_status, created_at DESC)',
  },
  {
    name: 'transactions_type_idx',
    sql: 'CREATE INDEX IF NOT EXISTS transactions_type_idx ON transactions (type, created_at DESC)',
  },
  {
    name: 'notifications_unread_partial_idx',
    sql: 'CREATE INDEX IF NOT EXISTS notifications_unread_partial_idx ON notifications (created_at DESC) WHERE is_read = false',
  },
  {
    name: 'publisher_websites_submission_status_idx',
    sql: 'CREATE INDEX IF NOT EXISTS publisher_websites_submission_status_idx ON publisher_websites (submission_status, updated_at DESC)',
  },
  {
    name: 'withdrawal_requests_status_created_idx',
    sql: 'CREATE INDEX IF NOT EXISTS withdrawal_requests_status_created_idx ON withdrawal_requests (withdrawal_status, created_at DESC)',
  },
];

module.exports = {
  async up(knex) {
    for (const { name, sql } of INDEXES) {
      console.log(`[MIGRATION] Creating index ${name}`);
      await knex.raw(sql);
      console.log(`[MIGRATION] Ensured ${name}`);
    }
  },

  async down(knex) {
    for (const { name } of INDEXES) {
      try {
        await knex.raw(`DROP INDEX IF EXISTS ${name}`);
      } catch (err) {
        console.warn(`[MIGRATION] Failed to drop ${name}: ${err.message}`);
      }
    }
  },
};
