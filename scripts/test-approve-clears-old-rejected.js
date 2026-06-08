#!/usr/bin/env node
'use strict';

/**
 * Scenario:
 *   1. Publisher edits → pending request A.
 *   2. Admin rejects request A.
 *   3. Publisher edits again → pending request B.
 *   4. Admin approves request B.
 *   5. Publisher's find() must show updateRequest: null for that website
 *      (the old rejection is stale; latest is approved).
 */

(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();
  const log = (...a) => process.stdout.write(a.join(' ') + '\n');

  const PW_ID = 14;
  const PW = (s) => strapi.db.query('api::publisher-website.publisher-website')[s];
  const WUR = (s) => strapi.db.query('api::website-update-request.website-update-request')[s];

  const createdReqIds = [];
  let origPwPrice;
  let origMktPrice;
  let mktId;

  try {
    const orig = await PW('findOne')({ where: { id: PW_ID } });
    origPwPrice = orig.generalGuestPostPrice;
    mktId = orig.marketplaceId;
    const origMkt = await strapi.db.query('api::marketplace.marketplace').findOne({ where: { id: mktId } });
    origMktPrice = origMkt.price;
    const publisher = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { email: orig.publisherEmail }, populate: ['role'],
    });
    log(`ORIGIN: pw.price=${origPwPrice}, mkt.price=${origMktPrice}`);

    const mkErrCtx = (params, body = {}) => ({
      params, request: { body },
      state: { user: publisher },
      unauthorized: m => ({ error: m }), forbidden: m => ({ error: m }),
      badRequest: m => ({ error: m }), notFound: m => ({ error: m }),
      internalServerError: m => ({ error: m }), send: b => b, _body: null,
    });
    const mkAdmCtx = (params, body = {}) => ({
      params, request: { body },
      state: { user: { id: 1, email: 'admin@test.com', role: { type: 'admin' } } },
      unauthorized: m => ({ error: m }), badRequest: m => ({ error: m }),
      notFound: m => ({ error: m }), internalServerError: m => ({ error: m }),
      _body: null, send: function (b) { this._body = b; return b; },
    });
    const pubCtrl = strapi.controller('api::publisher-website.publisher-website');
    const wurCtrl = strapi.controller('api::website-update-request.website-update-request');

    // Step 1: first publisher edit
    await pubCtrl.update({ ...mkErrCtx({ id: String(PW_ID) }, { data: { generalGuestPostPrice: origPwPrice + 50 } }) });
    const reqA = await WUR('findOne')({ where: { publisherWebsite: { id: PW_ID }, status: 'pending' }, orderBy: { id: 'desc' } });
    createdReqIds.push(reqA.id);
    log(`Step 1: req A=${reqA.id} pending`);

    // Step 2: admin rejects A
    await wurCtrl.reject(mkAdmCtx({ id: String(reqA.id) }, { reason: 'rejected old' }));
    log(`Step 2: req ${reqA.id} rejected`);

    // Step 3: second publisher edit (new pending request)
    await pubCtrl.update({ ...mkErrCtx({ id: String(PW_ID) }, { data: { generalGuestPostPrice: origPwPrice + 10 } }) });
    const reqB = await WUR('findOne')({ where: { publisherWebsite: { id: PW_ID }, status: 'pending' }, orderBy: { id: 'desc' } });
    createdReqIds.push(reqB.id);
    log(`Step 3: req B=${reqB.id} pending`);

    // Step 4: admin approves B
    await wurCtrl.approve(mkAdmCtx({ id: String(reqB.id) }));
    const reqBAfter = await WUR('findOne')({ where: { id: reqB.id } });
    log(`Step 4: req B status=${reqBAfter.status}`);

    // Step 5: publisher find() — should NOT show the old rejected banner.
    const findCtx = mkErrCtx({}, {});
    findCtx.query = {};
    findCtx._body = null;
    await pubCtrl.find(findCtx);
    const body = findCtx._body;
    const thisWebsite = (body?.data || []).find((w) => w.id === PW_ID);
    log(`\nPublisher find() for pw ${PW_ID}: updateRequest=${JSON.stringify(thisWebsite?.updateRequest)}`);

    log('\n=== RESULTS ===');
    if (!thisWebsite) {
      log('❌ website not in publisher find() result');
    } else if (thisWebsite.updateRequest == null) {
      log('✅ updateRequest is null — old rejected banner is NOT shown after newer approval');
    } else {
      log(`❌ updateRequest still present: status=${thisWebsite.updateRequest.status} — stale banner would render`);
    }
  } catch (e) {
    log('FATAL:', e.message, e.stack);
  } finally {
    // restore: revert pw + marketplace; delete created requests
    try {
      await PW('update')({ where: { id: PW_ID }, data: { generalGuestPostPrice: origPwPrice, _skipMarketplaceSync: true } });
      if (mktId != null && origMktPrice != null) {
        await strapi.db.query('api::marketplace.marketplace').update({ where: { id: mktId }, data: { price: origMktPrice } });
      }
      for (const rid of createdReqIds) await WUR('delete')({ where: { id: rid } });
      log('Cleanup done.');
    } catch (ce) { log('cleanup err:', ce.message); }
    await strapi.destroy();
    process.exit(0);
  }
})();
