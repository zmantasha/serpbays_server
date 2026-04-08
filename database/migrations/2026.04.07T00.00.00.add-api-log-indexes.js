'use strict';

/**
 * Migration: Add performance indexes for the api_logs table.
 *
 * The api-log collection is written for every non-trivial request and is
 * read by support / engineering for incident triage. These indexes keep
 * common access patterns fast even as the table grows toward the 30-day
 * retention horizon:
 *
 *   1. api_logs(created_at)              — recent-first listing + cron purge cutoff
 *   2. api_logs(user_id)                 — drill into a specific user's history
 *   3. api_logs(status_code)             — "show me all 5xx today"
 *   4. api_logs(path)                    — endpoint-specific drilldown
 *   5. api_logs(created_at, status_code) — error timeline composite
 *
 * Pattern mirrors the existing publisher_websites performance indexes
 * migration so behaviour stays consistent across SQLite (dev) and Postgres
 * (staging/prod). Failures from "index already exists" are swallowed so the
 * migration is idempotent and safe to re-run.
 */

module.exports = {
  async up(knex) {
    console.log('[MIGRATION] Adding performance indexes for api_logs...');

    const tableExists = await knex.schema.hasTable('api_logs');
    if (!tableExists) {
      console.log('[MIGRATION] Table api_logs does not exist yet — Strapi will create it on boot. Skipping index creation; rerun this migration after the table appears.');
      return;
    }

    const createIndexIfNotExists = async (indexName, columns) => {
      try {
        await knex.schema.alterTable('api_logs', (table) => {
          table.index(columns, indexName);
        });
        console.log(`[MIGRATION] Created index ${indexName} on api_logs(${columns.join(', ')})`);
      } catch (err) {
        if (
          err.message.includes('already exists') ||
          err.message.includes('SQLITE_ERROR') ||
          err.message.includes('duplicate')
        ) {
          console.log(`[MIGRATION] Index ${indexName} already exists, skipping`);
        } else {
          throw err;
        }
      }
    };

    await createIndexIfNotExists('idx_api_logs_created_at', ['created_at']);
    await createIndexIfNotExists('idx_api_logs_user_id', ['user_id']);
    await createIndexIfNotExists('idx_api_logs_status_code', ['status_code']);
    await createIndexIfNotExists('idx_api_logs_path', ['path']);
    await createIndexIfNotExists('idx_api_logs_created_at_status', ['created_at', 'status_code']);

    console.log('[MIGRATION] api_logs indexes added successfully');
  },

  async down(knex) {
    console.log('[MIGRATION] Removing api_logs performance indexes...');

    const dropIndexIfExists = async (indexName) => {
      try {
        await knex.schema.alterTable('api_logs', (table) => {
          table.dropIndex([], indexName);
        });
        console.log(`[MIGRATION] Dropped index ${indexName}`);
      } catch (_err) {
        console.log(`[MIGRATION] Index ${indexName} not found, skipping`);
      }
    };

    await dropIndexIfExists('idx_api_logs_created_at');
    await dropIndexIfExists('idx_api_logs_user_id');
    await dropIndexIfExists('idx_api_logs_status_code');
    await dropIndexIfExists('idx_api_logs_path');
    await dropIndexIfExists('idx_api_logs_created_at_status');
  },
};
