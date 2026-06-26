#!/usr/bin/env node
/**
 * Regression test for the submissionStatus enum.
 *
 * Confirms that every status value the code-base writes is accepted by the
 * schema's Yup validator. Catches a class of bug where a controller writes
 * a value that's not in the enum (e.g. 'requires_changes' written by
 * requestChanges() but missing from schema.json → YupValidationError →
 * controller returns 500).
 *
 * Run:
 *   cd serpbays_server
 *   node scripts/test-submission-status-enum.js
 *
 * Exit code: 0 on success, 1 on any failure.
 */
'use strict';
process.env.NODE_ENV = 'production';
process.chdir('/var/www/serpbays/serpbays_server');

// Every value the codebase writes via entityService. 'approved' is
// excluded — writing it triggers the marketplace-create lifecycle which has
// real publisher-row data dependencies (separate code path; not what this
// test is for). The enum's 'approved' value is exercised end-to-end by the
// existing GSC controller tests instead.
const REQUIRED_VALUES = [
  // publisher-settable
  'pending_verification',
  'pending_final_submission',
  'approval_pending',
  // admin intermediate (added 2026-06-12 — finding #1 fix)
  'under_review',
  'requires_changes',
  'verified_pending_review',
  // terminal / lifecycle (excl. 'approved' — see comment above)
  'rejected',
  'listing_paused',
  'ownership_claimed',
  'ownership_transferred',
];

// Schema enum SHOULD also contain 'approved' even though we don't exercise it
// in the live-write loop.
const SCHEMA_MUST_INCLUDE = [...REQUIRED_VALUES, 'approved'];

(async () => {
  const { createStrapi } = require('/var/www/serpbays/serpbays_server/node_modules/@strapi/strapi');
  const strapi = await createStrapi({ appDir: '/var/www/serpbays/serpbays_server' });
  await strapi.load();
  const Q = (uid) => strapi.db.query(uid);

  let pass = 0, fail = 0;
  const out = (...a) => process.stderr.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out('  ✅', label); }
    else      { fail++; out('  ❌', label); }
  };

  // --- 1. Static check: schema enum contains every required value ---
  const schema = strapi.contentTypes['api::publisher-website.publisher-website'];
  const enumValues = schema.attributes.submissionStatus.enum;
  out('\n=== 1) Schema enum currently declares:', enumValues.length, 'values ===');
  for (const v of SCHEMA_MUST_INCLUDE) {
    assert(enumValues.includes(v), `enum includes '${v}'`);
  }

  // --- 2. Live write check: each value can actually be persisted ---
  out('\n=== 2) Each value is acceptable to entityService.update ===');
  // Create a disposable row.
  const stamp = Date.now();
  const fixture = await Q('api::publisher-website.publisher-website').create({
    data: {
      url: `enum-test-${stamp}.example.com`,
      submissionStatus: 'pending_verification',
      stepCompleted: 1,
      publisherEmail: `enum-test-${stamp}@example.test`,
      publisherName: `enum-test-${stamp}`,
      countries: [], category: [], language: [], samplePosts: [],
      publishedAt: new Date(),
    },
  });

  try {
    for (const v of REQUIRED_VALUES) {
      try {
        await strapi.entityService.update(
          'api::publisher-website.publisher-website',
          fixture.id,
          { data: { submissionStatus: v, _skipMarketplaceSync: true } }
        );
        const row = await Q('api::publisher-website.publisher-website').findOne({ where: { id: fixture.id } });
        assert(row.submissionStatus === v, `wrote '${v}' and read back '${row.submissionStatus}'`);
      } catch (err) {
        fail++;
        out(`  ❌ writing '${v}' threw: ${err.name} - ${err.message.slice(0, 120)}`);
      }
    }
  } finally {
    // Cleanup.
    try { await Q('api::publisher-website.publisher-website').delete({ where: { id: fixture.id } }); } catch {}
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
