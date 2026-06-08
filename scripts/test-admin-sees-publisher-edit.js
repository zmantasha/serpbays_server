#!/usr/bin/env node
'use strict';

/**
 * After a publisher edits an APPROVED website, does the admin detail endpoint
 * (GET /admin/websites/:id → websites.findOne) return the publisher's NEW
 * price, or the old one?
 */

(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();

  const PW_ID = 14;
  const NEW_PRICE = 88;
  const log = (...a) => process.stdout.write(a.join(' ') + '\n');

  try {
    const pw = await strapi.db.query('api::publisher-website.publisher-website').findOne({ where: { id: PW_ID } });
    const origPrice = pw.generalGuestPostPrice;
    const publisher = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { email: pw.publisherEmail }, populate: ['role'],
    });

    log(`pw.generalGuestPostPrice BEFORE = ${origPrice}`);

    // 1) Publisher edits price
    const pubCtx = {
      params: { id: String(PW_ID) },
      request: { body: { data: { generalGuestPostPrice: NEW_PRICE } } },
      state: { user: publisher },
      unauthorized: m => ({ error: m }), forbidden: m => ({ error: m }),
      badRequest: m => ({ error: m }), notFound: m => ({ error: m }),
      internalServerError: m => ({ error: m }), send: b => b,
    };
    await strapi.controller('api::publisher-website.publisher-website').update(pubCtx);

    const pwAfter = await strapi.db.query('api::publisher-website.publisher-website').findOne({ where: { id: PW_ID } });
    log(`pw.generalGuestPostPrice AFTER publisher edit = ${pwAfter.generalGuestPostPrice}`);

    // 2) Admin opens website detail (invoke the real admin findOne)
    const adminCtx = {
      params: { id: String(PW_ID) },
      state: { user: { id: 1, role: { type: 'admin' } } },
      notFound: m => ({ error: m }),
      internalServerError: m => ({ error: m }),
      _body: null, send: function (b) { this._body = b; return b; },
    };
    const adminCtrl = strapi.controller('api::admin.websites');
    const result = await adminCtrl.findOne(adminCtx);
    // Strapi controllers can return the body or use ctx.send; check both
    const body = result || adminCtx._body;
    const adminSeesPrice = body?.data?.pricing?.general?.guestPost ?? body?.pricing?.general?.guestPost;

    log(`\nAdmin findOne returned price = ${adminSeesPrice}`);
    log(adminSeesPrice === NEW_PRICE
      ? `✅ admin sees the NEW price (${NEW_PRICE}) — endpoint reflects publisher edit`
      : `❌ admin sees ${adminSeesPrice}, expected ${NEW_PRICE} — endpoint is stale`);

    // ---- cleanup ----
    await strapi.db.query('api::publisher-website.publisher-website').update({
      where: { id: PW_ID }, data: { generalGuestPostPrice: origPrice },
    });
    const reqs = await strapi.db.query('api::website-update-request.website-update-request').findMany({
      where: { publisherWebsite: PW_ID, status: { $in: ['pending', 'superseded'] } },
    });
    for (const r of reqs) {
      await strapi.db.query('api::website-update-request.website-update-request').delete({ where: { id: r.id } });
    }
    log('Cleanup done.');
  } catch (e) {
    log('FATAL:', e.message, e.stack);
  } finally {
    await strapi.destroy();
    process.exit(0);
  }
})();
