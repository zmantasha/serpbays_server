#!/usr/bin/env node
/**
 * Regression test for duplicate-row prevention on publisher-website create
 * (audit finding #4).
 *
 * Pre-fix: a) wizard fallback queried by publisherEmail without filters[url]
 * and without pageSize override; for publishers with >20 listings the
 * existing-row check returned undefined and the fallback POSTed a duplicate.
 * b) Two concurrent POSTs both passed the controller's findMany dedup before
 * either insert — produced 5 duplicate rows from 5 parallel calls.
 *
 * This test asserts:
 *   1. Concurrent same-(url, user) POSTs collapse to a single row (advisory
 *      lock).
 *   2. Sequential same-(url, user) POSTs against a pre-approval row return
 *      the existing row idempotently (no new row).
 *   3. Sequential POSTs against an already-approved row return 409, leaving
 *      the row's verification state intact.
 *   4. The race-safety guard does not break the happy path (a single POST
 *      for a brand-new URL still creates the row normally).
 *
 * Run:
 *   cd serpbays_server
 *   node scripts/test-duplicate-prevention.js
 */
'use strict';
process.env.NODE_ENV = 'production';
process.chdir('/var/www/serpbays/serpbays_server');

(async () => {
  const { createStrapi } = require('/var/www/serpbays/serpbays_server/node_modules/@strapi/strapi');
  const strapi = await createStrapi({ appDir: '/var/www/serpbays/serpbays_server' });
  await strapi.load();
  const Q = (uid) => strapi.db.query(uid);
  const ctrl = strapi.controller('api::publisher-website.publisher-website');

  let pass = 0, fail = 0;
  const out = (...a) => process.stderr.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out('  ✅', label); }
    else      { fail++; out('  ❌', label); }
  };

  const stamp = Date.now();
  const role = await Q('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const user = await Q('plugin::users-permissions.user').create({
    data: { username: `dup-test-${stamp}`, email: `dup-test-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });

  const mkCtx = (body) => {
    const c = {
      params: {}, state: { user }, request: { body: { data: body } },
      _body: null, _err: null, _status: 200,
      send(b) { c._body = b; return b; },
      badRequest(m) { c._err = { code: 400, msg: m }; return c._err; },
      unauthorized(m) { c._err = { code: 401, msg: m }; return c._err; },
      forbidden(m) { c._err = { code: 403, msg: m }; return c._err; },
      notFound(m) { c._err = { code: 404, msg: m }; return c._err; },
      internalServerError(m) { c._err = { code: 500, msg: m }; return c._err; },
    };
    Object.defineProperty(c, 'status', { get() { return c._status; }, set(v) { c._status = v; } });
    Object.defineProperty(c, 'body',   { get() { return c._body; },   set(v) { c._body = v; } });
    return c;
  };
  const countFor = async (url) => (await Q('api::publisher-website.publisher-website').findMany({ where: { url } })).length;
  const cleanupByUrl = async (url) => {
    const rows = await Q('api::publisher-website.publisher-website').findMany({ where: { url }, select: ['id'] });
    for (const r of rows) {
      try {
        await strapi.db.connection('publisher_websites_current_publisher_id_lnk').where({ publisher_website_id: r.id }).delete();
        await strapi.db.connection('publisher_websites_original_publisher_id_lnk').where({ publisher_website_id: r.id }).delete();
        await Q('api::publisher-website.publisher-website').delete({ where: { id: r.id } });
      } catch {}
    }
  };

  try {
    out('\n=== 1) Concurrent same-(url, user) POSTs collapse to ONE row ===');
    const url1 = `dup-test-concurrent-${stamp}.example.com`;
    const N = 5;
    const ctxs = Array.from({ length: N }, () => mkCtx({ url: url1, generalGuestPostPrice: 50 }));
    const results1 = await Promise.all(ctxs.map((c) => ctrl.create(c)));
    const count1 = await countFor(url1);
    assert(count1 === 1, `${N} concurrent create() calls produced ${count1} row(s) (expected 1)`);
    // Each call returns either { data, alreadyExists? } (created or idempotent).
    // None should throw or return an _err. With the lock, ONE caller gets the
    // create result; the others see the existing row and get alreadyExists=true.
    const created = results1.filter((r) => r && r.data && !r.alreadyExists).length;
    const idempotent = results1.filter((r) => r && r.alreadyExists === true).length;
    assert(created === 1, `exactly 1 caller saw the create (got ${created})`);
    assert(idempotent === N - 1, `${N - 1} callers got idempotent return (got ${idempotent})`);
    assert(ctxs.every((c) => !c._err), 'no caller hit an error path');
    await cleanupByUrl(url1);

    out('\n=== 2) Sequential pre-approval re-POST returns existing idempotently ===');
    const url2 = `dup-test-idempotent-${stamp}.example.com`;
    const c2a = mkCtx({ url: url2, generalGuestPostPrice: 30 });
    const r2a = await ctrl.create(c2a);
    const c2b = mkCtx({ url: url2, generalGuestPostPrice: 999 });  // try to overwrite price
    const r2b = await ctrl.create(c2b);
    const count2 = await countFor(url2);
    assert(count2 === 1, `sequential re-POST kept 1 row (got ${count2})`);
    assert(r2a && r2a.data && !r2a.alreadyExists, 'first POST returned a created row');
    assert(r2b && r2b.alreadyExists === true, 'second POST returned alreadyExists=true');
    const row2 = await Q('api::publisher-website.publisher-website').findOne({ where: { url: url2 } });
    assert(row2.generalGuestPostPrice !== 999, 'price NOT overwritten by the duplicate POST');
    await cleanupByUrl(url2);

    out('\n=== 3) Re-POST against an approved row returns 409, no overwrite ===');
    const url3 = `dup-test-approved-${stamp}.example.com`;
    // Create + manually elevate to approved + gscVerified
    const c3a = mkCtx({ url: url3, generalGuestPostPrice: 100 });
    await ctrl.create(c3a);
    const row3 = await Q('api::publisher-website.publisher-website').findOne({ where: { url: url3 } });
    await Q('api::publisher-website.publisher-website').update({
      where: { id: row3.id },
      data: { submissionStatus: 'approved', stepCompleted: 4, gscVerified: true, verificationMethod: 'google-search-console', gscVerifiedAt: new Date() },
    });
    const c3b = mkCtx({ url: url3, generalGuestPostPrice: 9999 });
    await ctrl.create(c3b);
    assert(c3b._status === 409, `second POST returned HTTP ${c3b._status} (expected 409)`);
    assert(c3b._body && c3b._body.error && c3b._body.error.name === 'ConflictError', '409 body has ConflictError');
    const row3After = await Q('api::publisher-website.publisher-website').findOne({ where: { id: row3.id } });
    assert(row3After.submissionStatus === 'approved', 'approved status preserved');
    assert(row3After.gscVerified === true, 'gscVerified preserved');
    assert(row3After.generalGuestPostPrice !== 9999, 'price not overwritten');
    await cleanupByUrl(url3);

    out('\n=== 4) Happy path: single POST for brand-new URL still creates ===');
    const url4 = `dup-test-happy-${stamp}.example.com`;
    const c4 = mkCtx({ url: url4, generalGuestPostPrice: 60 });
    const r4 = await ctrl.create(c4);
    const count4 = await countFor(url4);
    assert(count4 === 1, `single POST created exactly 1 row (got ${count4})`);
    assert(r4 && r4.data && !r4.alreadyExists, 'happy path returned data without alreadyExists');
    await cleanupByUrl(url4);

  } finally {
    try { await Q('plugin::users-permissions.user').delete({ where: { id: user.id } }); } catch {}
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
