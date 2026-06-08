#!/usr/bin/env node
'use strict';

/**
 * Verify that admin reject of a website-update-request reverts the
 * publisher_websites row back to the last-approved (baseSnapshot) values,
 * so the publisher's "My Websites" view stops showing the rejected edit.
 */

(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();
  const log = (...a) => process.stdout.write(a.join(' ') + '\n');

  const PW_ID = 14;
  const NEW_PRICE = 99;
  const PW = (s) => strapi.db.query('api::publisher-website.publisher-website')[s];
  const WUR = (s) => strapi.db.query('api::website-update-request.website-update-request')[s];

  try {
    const orig = await PW('findOne')({ where: { id: PW_ID } });
    const publisher = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { email: orig.publisherEmail }, populate: ['role'],
    });
    log(`BEFORE: pw.price=${orig.generalGuestPostPrice}, status=${orig.submissionStatus}`);

    // 1) Publisher edits price
    const editCtx = {
      params: { id: String(PW_ID) },
      request: { body: { data: { generalGuestPostPrice: NEW_PRICE } } },
      state: { user: publisher },
      unauthorized: m => ({ error: m }), forbidden: m => ({ error: m }),
      badRequest: m => ({ error: m }), notFound: m => ({ error: m }),
      internalServerError: m => ({ error: m }), send: b => b,
    };
    await strapi.controller('api::publisher-website.publisher-website').update(editCtx);

    const pwAfterEdit = await PW('findOne')({ where: { id: PW_ID } });
    log(`AFTER EDIT: pw.price=${pwAfterEdit.generalGuestPostPrice} (expect ${NEW_PRICE})`);

    const pendingReq = await WUR('findOne')({
      where: { publisherWebsite: { id: PW_ID }, status: 'pending' },
      orderBy: { id: 'desc' },
    });
    if (!pendingReq) throw new Error('No pending request created');
    log(`Pending req ${pendingReq.id}: changes=${JSON.stringify(pendingReq.changes)} base=${JSON.stringify(pendingReq.baseSnapshot)}`);

    // 2) Admin rejects
    const rejectCtx = {
      params: { id: String(pendingReq.id) },
      request: { body: { reason: 'Test rejection — price too high' } },
      state: { user: { id: 1, email: 'admin@test.com', role: { type: 'admin' } } },
      unauthorized: m => ({ error: m }), badRequest: m => ({ error: m }),
      notFound: m => ({ error: m }), internalServerError: m => ({ error: m }),
      _body: null, send: function (b) { this._body = b; return b; },
    };
    await strapi.controller('api::website-update-request.website-update-request').reject(rejectCtx);
    log(`Reject response: ${JSON.stringify(rejectCtx._body)}`);

    // 3) Verify state
    const pwAfterReject = await PW('findOne')({ where: { id: PW_ID } });
    const reqAfterReject = await WUR('findOne')({ where: { id: pendingReq.id } });

    log(`\nAFTER REJECT: pw.price=${pwAfterReject.generalGuestPostPrice}, req.status=${reqAfterReject.status}, req.notes='${reqAfterReject.notes}'`);

    log('\n=== RESULTS ===');
    // The correct revert target is the baseSnapshot value (= last-approved
    // marketplace data), NOT whatever pw happened to be before the edit.
    const expectedAfter = pendingReq.baseSnapshot?.price ?? orig.generalGuestPostPrice;
    if (pwAfterReject.generalGuestPostPrice === expectedAfter) {
      log(`✅ pw.price reverted to last-approved value (${expectedAfter}) — matches marketplace`);
    } else {
      log(`❌ pw.price is ${pwAfterReject.generalGuestPostPrice}, expected ${expectedAfter}`);
    }
    if (reqAfterReject.status === 'rejected') log('✅ request marked rejected');
    else log(`❌ request status: ${reqAfterReject.status}`);
    if (reqAfterReject.notes?.includes('Test rejection')) log('✅ rejection reason captured');
    else log(`❌ notes: '${reqAfterReject.notes}'`);

    // cleanup: revert pw + delete test request
    await PW('update')({ where: { id: PW_ID }, data: { generalGuestPostPrice: orig.generalGuestPostPrice } });
    await WUR('delete')({ where: { id: pendingReq.id } });
    log('Cleanup done.');
  } catch (e) {
    log('FATAL:', e.message, e.stack);
  } finally {
    await strapi.destroy();
    process.exit(0);
  }
})();
