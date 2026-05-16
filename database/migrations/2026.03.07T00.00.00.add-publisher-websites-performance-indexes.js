'use strict';

/**
 * Migration: Add performance indexes for publisher-websites and marketplaces tables.
 *
 * These indexes dramatically speed up the "My Websites" page for publishers
 * with large numbers of websites (20k+) by eliminating full table scans.
 *
 * Indexes added:
 * 1. publisher_websites(submission_status) — filters by status
 * 2. publisher_websites(publisher_email) — fallback publisher lookup
 * 3. publisher_websites(url) — search by domain and marketplace URL matching
 * 4. publisher_websites(updated_at) — default sort order
 * 5. marketplaces(url) — URL-based marketplace lookups
 * 6. marketplaces(publisher_email) — publisher email matching
 * 7. marketplaces(status) — status filtering (active/delisted/etc)
 *
 * Note: currentPublisherId is a relation stored in a link table
 * (publisher_websites_current_publisher_id_lnk) which already has indexes.
 * Similarly, marketplaces.publisher is in marketplaces_publisher_lnk with indexes.
 */

module.exports = {
  async up(knex) {
    console.log('[MIGRATION] Adding performance indexes for publisher-websites and marketplaces...');

    // Helper: create index only if it doesn't already exist
    const createIndexIfNotExists = async (tableName, indexName, columns) => {
      const hasIndex = await knex.schema.hasTable(tableName);
      if (!hasIndex) {
        console.log(`[MIGRATION] Table ${tableName} does not exist, skipping index ${indexName}`);
        return;
      }

      try {
        await knex.schema.alterTable(tableName, (table) => {
          table.index(columns, indexName);
        });
        console.log(`[MIGRATION] Created index ${indexName} on ${tableName}(${columns.join(', ')})`);
      } catch (err) {
        // Index may already exist — that's fine
        if (err.message.includes('already exists') || err.message.includes('SQLITE_ERROR')) {
          console.log(`[MIGRATION] Index ${indexName} already exists, skipping`);
        } else {
          throw err;
        }
      }
    };

    // publisher_websites indexes
    await createIndexIfNotExists('publisher_websites', 'idx_pw_submission_status', ['submission_status']);
    await createIndexIfNotExists('publisher_websites', 'idx_pw_publisher_email', ['publisher_email']);
    await createIndexIfNotExists('publisher_websites', 'idx_pw_url', ['url']);
    await createIndexIfNotExists('publisher_websites', 'idx_pw_updated_at', ['updated_at']);

    // marketplaces indexes
    await createIndexIfNotExists('marketplaces', 'idx_mp_url', ['url']);
    await createIndexIfNotExists('marketplaces', 'idx_mp_publisher_email', ['publisher_email']);
    await createIndexIfNotExists('marketplaces', 'idx_mp_status', ['status']);

    console.log('[MIGRATION] Performance indexes added successfully');
  },

  async down(knex) {
    console.log('[MIGRATION] Removing performance indexes...');

    const dropIndexIfExists = async (tableName, indexName) => {
      try {
        await knex.schema.alterTable(tableName, (table) => {
          table.dropIndex([], indexName);
        });
        console.log(`[MIGRATION] Dropped index ${indexName}`);
      } catch (err) {
        console.log(`[MIGRATION] Index ${indexName} not found, skipping`);
      }
    };

    await dropIndexIfExists('publisher_websites', 'idx_pw_submission_status');
    await dropIndexIfExists('publisher_websites', 'idx_pw_publisher_email');
    await dropIndexIfExists('publisher_websites', 'idx_pw_url');
    await dropIndexIfExists('publisher_websites', 'idx_pw_updated_at');

    await dropIndexIfExists('marketplaces', 'idx_mp_url');
    await dropIndexIfExists('marketplaces', 'idx_mp_publisher_email');
    await dropIndexIfExists('marketplaces', 'idx_mp_status');

    console.log('[MIGRATION] Performance indexes removed');
  }
};
