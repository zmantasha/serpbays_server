#!/usr/bin/env node
'use strict';

/**
 * Smoke test: user.afterUpdate lifecycle cascades email changes to
 * marketplaces.publisher_email (denormalized cache).
 *
 * Reverts everything before exit — leaves staging in the original state.
 */

(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();

  const TEST_USER_ID = 260;
  const ORIGINAL_EMAIL = 'mantasha@wordscloud.in';
  const TEST_EMAIL = `cascade-test-${Date.now()}@example.invalid`;

  let testPassed = false;

  try {
    // Confirm starting state
    const beforeRow = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: TEST_USER_ID } });
    console.log(`Starting state: user ${TEST_USER_ID} email = ${beforeRow.email}`);
    if (beforeRow.email !== ORIGINAL_EMAIL) {
      throw new Error(`User ${TEST_USER_ID} email is not ${ORIGINAL_EMAIL} — abort test`);
    }

    const beforeMarketplaces = await strapi.db.connection('marketplaces')
      .whereIn('id',
        strapi.db.connection('marketplaces_publisher_lnk')
          .select('marketplace_id').where({ user_id: TEST_USER_ID }))
      .select('id', 'publisher_email');
    console.log(`User owns ${beforeMarketplaces.length} marketplaces, all with publisher_email = ${beforeMarketplaces[0]?.publisher_email}`);

    // Change email — should trigger afterUpdate cascade
    console.log(`\nChanging email to: ${TEST_EMAIL}`);
    await strapi.entityService.update('plugin::users-permissions.user', TEST_USER_ID, {
      data: { email: TEST_EMAIL },
    });

    // Verify cascade ran
    const afterMarketplaces = await strapi.db.connection('marketplaces')
      .whereIn('id',
        strapi.db.connection('marketplaces_publisher_lnk')
          .select('marketplace_id').where({ user_id: TEST_USER_ID }))
      .select('id', 'publisher_email');

    const allUpdated = afterMarketplaces.every((m) => m.publisher_email === TEST_EMAIL);

    if (allUpdated && afterMarketplaces.length > 0) {
      console.log(`✅ PASS: all ${afterMarketplaces.length} marketplaces' publisher_email updated to ${TEST_EMAIL}`);
      testPassed = true;
    } else {
      console.log('❌ FAIL: marketplaces did not all update');
      console.log(`   ${afterMarketplaces.length} marketplaces, publisher_emails: ${[...new Set(afterMarketplaces.map((m) => m.publisher_email))]}`);
    }
  } catch (err) {
    console.log('❌ TEST ERROR:', err.message);
  } finally {
    // Revert: always restore original email
    console.log(`\nReverting user ${TEST_USER_ID} email to ${ORIGINAL_EMAIL}`);
    try {
      await strapi.entityService.update('plugin::users-permissions.user', TEST_USER_ID, {
        data: { email: ORIGINAL_EMAIL },
      });

      const reverted = await strapi.db.connection('marketplaces')
        .whereIn('id',
          strapi.db.connection('marketplaces_publisher_lnk')
            .select('marketplace_id').where({ user_id: TEST_USER_ID }))
        .select('publisher_email').first();
      console.log(`Revert verify: marketplace publisher_email = ${reverted?.publisher_email}`);
    } catch (e) {
      console.log('⚠️  Revert failed:', e.message);
    }

    await strapi.destroy();
    process.exit(testPassed ? 0 : 1);
  }
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
