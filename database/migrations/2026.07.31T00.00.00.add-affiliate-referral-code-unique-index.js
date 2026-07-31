'use strict';

/**
 * Migration: enforce uniqueness of affiliate_profiles.referral_code at the
 * DB layer.
 *
 * The Strapi schema declares `"unique": true` on referralCode, but Strapi 5
 * does NOT translate schema-level unique into a Postgres UNIQUE constraint
 * for scalar attributes on regular content types (only documentId + some
 * relation tables get automatic uniques). Every real uniqueness enforcement
 * has to be added by explicit migration.
 *
 * Without this index, the setCustomCode / regenerateMyCode / apply flows
 * are racy: two concurrent requests both pass the app-layer pre-check
 * (`SELECT ... where referralCode=?`) before either write lands, and both
 * succeed. Attribution of subsequent clicks becomes ambiguous — a real
 * money bug because commission credits could go to the wrong affiliate.
 *
 * The controller layer already handles Postgres error 23505 (unique
 * violation) and returns a clean 409 — see setCustomCode in
 * src/api/affiliate-profile/controllers/affiliate-profile.js. Once this
 * index exists, that catch actually fires.
 *
 * Multiple NULL referral_code values are still allowed. NULL doesn't
 * violate a UNIQUE constraint in Postgres; only distinct non-null values
 * are enforced. This matters because early rows may have been created
 * without codes, or with the code cleared during termination workflows.
 *
 * Non-concurrent CREATE — the table is tiny (< 100 rows in every env we
 * care about) and the write lock lasts milliseconds. If this ever runs
 * against a huge table, switch to CONCURRENTLY (which must run outside a
 * transaction, so it can't be a plain Strapi migration — do it via psql
 * or a maintenance-window ops script).
 *
 * Idempotent — IF NOT EXISTS. Down migration drops the index.
 *
 * Pre-flight check: refuses to create if duplicates exist (loud fail
 * beats a mysterious mid-migration error). Any duplicates in production
 * must be resolved by hand before this ships — flip one row's code to
 * a fresh auto-generated slug, keeping the more-active affiliate on
 * their claimed value.
 */

const INDEX_NAME = 'affiliate_profiles_referral_code_unique';

async function up(knex) {
  const dupes = await knex('affiliate_profiles')
    .select('referral_code')
    .count('* as n')
    .whereNotNull('referral_code')
    .groupBy('referral_code')
    .havingRaw('COUNT(*) > 1');
  if (dupes.length > 0) {
    const list = dupes.map((r) => `${r.referral_code}(x${r.n})`).join(', ');
    throw new Error(
      `Cannot create UNIQUE index — duplicate referral_code values exist: ${list}. ` +
      'Resolve dupes by rotating one row before running this migration.'
    );
  }

  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME} ON affiliate_profiles (referral_code)`
  );
  console.log(`[migration] created UNIQUE index ${INDEX_NAME} on affiliate_profiles.referral_code`);
}

async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
}

module.exports = { up, down };
