'use strict';

/**
 * Migration: partial UNIQUE INDEX on the canonical form of marketplaces.url.
 *
 * Prevents future dupes like `Foo.com` / `foo.com` / `www.foo.com` /
 * `https://Foo.com/` all coexisting as separate listings. The expression
 * MUST mirror src/utils/normalize-url.js exactly — if it drifts, app-layer
 * normalization and DB enforcement disagree and inserts that look fine to
 * JS get rejected by Postgres.
 *
 * Partial WHERE status <> 'delisted' so soft-delisted dupes (kept for
 * order-history integrity) don't block re-listing a fresh, distinct domain
 * whose canonical happens to match an old delisted entry.
 *
 * Idempotent via IF NOT EXISTS — on prod-cms.serpbays.com this index was
 * created manually after the initial dedup + backfill, so this migration
 * is a no-op there. On fresh staging/dev DBs it creates the index from
 * scratch.
 */

const INDEX_NAME = 'marketplaces_url_canonical_uniq';

// Mirrors normalizeUrl() in src/utils/normalize-url.js:
//   trim().toLowerCase()       <- LOWER must be innermost
//   strip ^https?://
//   strip ^www\.
//   keep host only (drop /...)
const CANONICAL_EXPR = `REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(url), '^https?://', ''), '^www\\.', ''), '/.*$', '')`;

module.exports = {
  async up(knex) {
    console.log(`[MIGRATION] Ensuring unique index ${INDEX_NAME} on canonical marketplaces.url...`);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
      ON marketplaces (${CANONICAL_EXPR})
      WHERE status IS DISTINCT FROM 'delisted'
    `);
    console.log(`[MIGRATION] Ensured ${INDEX_NAME}`);
  },

  async down(knex) {
    console.log(`[MIGRATION] Dropping ${INDEX_NAME}...`);
    await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  },
};
