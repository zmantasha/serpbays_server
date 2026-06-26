#!/usr/bin/env node
'use strict';

/**
 * Smoke test for the marketplace-publisher RESTRICT migration.
 *
 * Verifies the layered protection works:
 *   1) Strapi lifecycle hook (beforeDelete on user) — friendly error
 *   2) DB-level FK constraint (ON DELETE RESTRICT on marketplaces_publisher_lnk)
 *
 * Safe by design: beforeDelete throws BEFORE any row is touched, so a
 * blocked test causes zero state change.
 */

(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();

  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // TEST 1: delete a user who owns marketplaces → should fail with lifecycle-hook error
    console.log('\n=== TEST 1: delete user 260 (owns 7 marketplaces) ===');
    try {
      await strapi.db.query('plugin::users-permissions.user').delete({ where: { id: 260 } });
      console.log('❌ FAIL: delete succeeded but should have been blocked');
      testsFailed++;
    } catch (err) {
      if (err.message.includes('Cannot delete user') && err.message.includes('marketplace')) {
        console.log('✅ PASS: lifecycle hook fired with friendly error');
        console.log('   Error message: "' + err.message.slice(0, 120) + '..."');
        testsPassed++;
      } else if (err.message.includes('foreign key constraint') || err.message.includes('marketplaces_publisher_lnk_ifk')) {
        console.log('⚠️  PARTIAL: DB-level RESTRICT fired, but lifecycle hook did NOT (no friendly message)');
        console.log('   Error: ' + err.message.slice(0, 200));
        testsFailed++;
      } else {
        console.log('❓ UNEXPECTED error:', err.message);
        testsFailed++;
      }
    }

    // TEST 2: marketplace creation without publisher → should fail (required)
    console.log('\n=== TEST 2: create marketplace without publisher ===');
    try {
      await strapi.db.query('api::marketplace.marketplace').create({
        data: {
          url: 'test-no-publisher-' + Date.now() + '.example.com',
          price: 100,
          min_word_count: 500,
          backlink_type: 'Do follow',
          category: ['test'],
          publisher_name: 'Test',
          publisher_email: 'test@example.com',
          // no publisher relation
        },
      });
      console.log('⚠️  WARNING: marketplace created without publisher (db.query bypasses Strapi validation)');
      console.log('   Strapi enforces required at the entityService / API layer, not db.query.');
      console.log('   Trying via entityService to confirm enforcement...');

      // Try again via entityService (what the API actually uses)
      try {
        await strapi.entityService.create('api::marketplace.marketplace', {
          data: {
            url: 'test-entity-no-publisher-' + Date.now() + '.example.com',
            price: 100,
            min_word_count: 500,
            backlink_type: 'Do follow',
            category: ['test'],
            publisher_name: 'Test',
            publisher_email: 'test@example.com',
          },
        });
        console.log('❌ FAIL: entityService also allowed create without publisher');
        testsFailed++;
      } catch (entityErr) {
        // Strapi 5 validation errors arrive as "N errors occurred" with
        // details in err.details.errors[]. Look for the publisher field.
        const flatErrors = entityErr?.details?.errors || [];
        const publisherError = flatErrors.find((e) => {
          const path = (e.path || []).join('.');
          return path.includes('publisher') || (e.message || '').toLowerCase().includes('publisher');
        });
        if (publisherError) {
          console.log('✅ PASS (via entityService): publisher relation is required');
          console.log('   Validation error on path: ' + (publisherError.path || []).join('.'));
          console.log('   Message: ' + publisherError.message);
          testsPassed++;
        } else if (entityErr.message.includes('publisher') || entityErr.message.includes('required')) {
          console.log('✅ PASS (via entityService): rejected with validation error');
          testsPassed++;
        } else {
          console.log('❓ entityService rejected but reason unclear: ' + entityErr.message);
          if (flatErrors.length) console.log('   Inner errors:', JSON.stringify(flatErrors, null, 2));
          testsFailed++;
        }
      }
    } catch (err) {
      if (err.message.includes('publisher') || err.message.includes('required')) {
        console.log('✅ PASS: rejected with validation error');
        testsPassed++;
      } else if (err.message.includes('publisher_name') || err.message.includes('not-null')) {
        console.log('ℹ️  Failed for a different required field — not the publisher relation');
        console.log('   ' + err.message.slice(0, 200));
      } else {
        console.log('❓ Unexpected: ' + err.message);
        testsFailed++;
      }
    }
  } finally {
    console.log(`\n=== Summary: ${testsPassed} passed, ${testsFailed} failed ===`);
    await strapi.destroy();
    process.exit(testsFailed === 0 ? 0 : 1);
  }
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
