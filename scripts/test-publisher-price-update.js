#!/usr/bin/env node
'use strict';

/**
 * Tests that a publisher editing an APPROVED website's price does NOT push the
 * change live to the marketplace — it should only create a pending
 * website-update-request. Exercises the real publisher-website.update()
 * controller via a mock ctx. Reverts all changes before exit.
 */

(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();

  const PW_ID = 14; // testing6.com, approved, marketplace 680, owner mantasha+3
  const NEW_PRICE = 77;
  let testPassed = true;
  const log = (...a) => process.stdout.write(a.join(' ') + '\n');

  try {
    const pw = await strapi.db.query('api::publisher-website.publisher-website').findOne({ where: { id: PW_ID } });
    if (!pw) throw new Error(`publisher-website ${PW_ID} not found`);
    const origPrice = pw.generalGuestPostPrice;
    const mkt = await strapi.db.query('api::marketplace.marketplace').findOne({ where: { id: pw.marketplaceId } });
    const beforeMktPrice = mkt?.price;

    const publisher = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { email: pw.publisherEmail }, populate: ['role'],
    });
    if (!publisher) throw new Error(`publisher ${pw.publisherEmail} not found`);

    const beforePending = await strapi.db.query('api::website-update-request.website-update-request').count({
      where: { publisherWebsite: PW_ID, status: 'pending' },
    });

    log(`\nBEFORE: pw.price=${origPrice}, marketplace.price=${beforeMktPrice}, pw.status=${pw.submissionStatus}, pendingReqs=${beforePending}`);

    // Build a mock ctx mimicking PUT /api/publisher-websites/:id from the publisher
    const errors = [];
    const ctx = {
      params: { id: String(PW_ID) },
      request: { body: { data: { generalGuestPostPrice: NEW_PRICE } } },
      state: { user: publisher },
      unauthorized: (m) => { errors.push(['unauthorized', m]); return { error: m }; },
      forbidden: (m) => { errors.push(['forbidden', m]); return { error: m }; },
      badRequest: (m) => { errors.push(['badRequest', m]); return { error: m }; },
      notFound: (m) => { errors.push(['notFound', m]); return { error: m }; },
      internalServerError: (m) => { errors.push(['internalServerError', m]); return { error: m }; },
      send: (b) => b,
    };

    const controller = strapi.controller('api::publisher-website.publisher-website');
    log(`\nCall #1: publisher update() price ${origPrice} → ${NEW_PRICE} as ${publisher.email} ...`);
    await controller.update(ctx);
    if (errors.length) log('Controller returned error(s):', JSON.stringify(errors));

    // Second edit — should create a new pending request AND supersede the first
    const ctx2 = { ...ctx, request: { body: { data: { generalGuestPostPrice: NEW_PRICE + 1 } } } };
    log(`\nCall #2: publisher update() price → ${NEW_PRICE + 1} (should supersede call #1's request) ...`);
    await controller.update(ctx2);
    const supersededCount = await strapi.db.query('api::website-update-request.website-update-request').count({
      where: { publisherWebsite: PW_ID, status: 'superseded' },
    });
    log(`superseded requests now: ${supersededCount} (expect ≥1, proving supersede no longer throws)`);

    // Re-read state
    const mktAfter = await strapi.db.query('api::marketplace.marketplace').findOne({ where: { id: pw.marketplaceId } });
    const pwAfter = await strapi.db.query('api::publisher-website.publisher-website').findOne({ where: { id: PW_ID } });
    const afterPending = await strapi.db.query('api::website-update-request.website-update-request').count({
      where: { publisherWebsite: PW_ID, status: 'pending' },
    });

    log(`\nAFTER: pw.price=${pwAfter.generalGuestPostPrice}, marketplace.price=${mktAfter.price}, pw.status=${pwAfter.submissionStatus}, pendingReqs=${afterPending}`);

    log('\n=== RESULTS ===');
    // 1. Marketplace price must NOT change
    if (mktAfter.price === beforeMktPrice) {
      log(`✅ marketplace price unchanged (${beforeMktPrice}) — NOT live`);
    } else {
      log(`❌ marketplace price CHANGED ${beforeMktPrice} → ${mktAfter.price} — went LIVE without approval (BUG)`);
      testPassed = false;
    }
    // 2. Website stays approved
    if (pwAfter.submissionStatus === 'approved') {
      log(`✅ website still 'approved' (live)`);
    } else {
      log(`❌ website status changed to '${pwAfter.submissionStatus}'`);
      testPassed = false;
    }
    // 3. A pending update-request was created
    if (afterPending > beforePending) {
      log(`✅ pending update-request created (${beforePending} → ${afterPending})`);
    } else {
      log(`❌ no pending update-request created`);
      testPassed = false;
    }

    // ---- cleanup ----
    log('\nCleaning up (revert pw price, delete test pending request)...');
    await strapi.db.query('api::publisher-website.publisher-website').update({
      where: { id: PW_ID }, data: { generalGuestPostPrice: origPrice },
    });
    const testReqs = await strapi.db.query('api::website-update-request.website-update-request').findMany({
      where: { publisherWebsite: PW_ID, status: { $in: ['pending', 'superseded'] } }, orderBy: { id: 'desc' },
    });
    for (const r of testReqs) {
      await strapi.db.query('api::website-update-request.website-update-request').delete({ where: { id: r.id } });
    }
    log('Cleanup done.');
  } catch (e) {
    log('FATAL:', e.message);
    testPassed = false;
  } finally {
    log(`\n=== ${testPassed ? 'PASS' : 'FAIL'} ===`);
    await strapi.destroy();
    process.exit(testPassed ? 0 : 1);
  }
})();
