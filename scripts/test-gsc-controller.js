#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the GSC verification controller (init + callback)
 * against a running Strapi instance. Bypasses the network — invokes the
 * controllers directly with mock ctx objects. The Google API call is
 * replaced by a `properties` array we craft to exercise each scenario.
 *
 * Scenarios:
 *   1. Happy path        — properties cover the row → gscVerified=true.
 *   2. Unowned site      — properties don't include the row → forbidden.
 *   3. URL-prefix match  — exact-host coverage works.
 *   4. Domain property   — sc-domain on apex covers row.
 *   5. Subdomain         — sc-domain covers blog.example.com; URL-prefix
 *                          does not.
 *   6. Wrong owner       — init by user A, but row owned by user B → denied.
 *   7. Replay            — second call with same signature → rejected.
 *   8. Idempotency       — second call with fresh signature on already-
 *                          verified row → no-op success.
 *   9. Tampered HMAC     — wrong signature → unauthorized.
 *  10. Expired timestamp — old timestamp → unauthorized.
 *  11. Bad nonce         — random nonce not in store → unauthorized.
 */

const path = require('path');
const crypto = require('crypto');
process.env.GSC_VERIFY_SHARED_SECRET = 'test-secret-' + 'x'.repeat(32);

(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();
  const gsc = require(path.resolve(__dirname, '..', 'src', 'utils', 'gsc-helpers.js'));
  const Q = (uid) => strapi.db.query(uid);

  let pass = 0, fail = 0;
  const out = (...a) => process.stdout.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out(`  ✅ ${label}`); }
    else      { fail++; out(`  ❌ ${label}`); }
  };

  // --- helpers --------------------------------------------------------------
  let counter = 0;
  const mkUserAndWebsite = async (url = 'verify-test-example.com') => {
    counter++;
    const stamp = `${Date.now()}-${counter}`;
    const user = await Q('plugin::users-permissions.user').create({
      data: { username: `t-${stamp}`, email: `t-${stamp}@example.test`, provider: 'local', confirmed: true },
    });
    const website = await Q('api::publisher-website.publisher-website').create({
      data: {
        url, submissionStatus: 'pending_verification', stepCompleted: 1,
        publisherEmail: user.email, publisherName: user.username,
        currentPublisherId: user.id, originalPublisherId: user.id,
        // JSON columns: must be JSON-shaped, not Postgres array literals.
        // Explicitly pass empty arrays to override any lifecycle defaults.
        countries: [], category: [], language: [], samplePosts: [],
        publishedAt: new Date(),
      },
    });
    return { user, website };
  };
  const cleanup = async ({ user, website }) => {
    try {
      await Q('api::publisher-website.publisher-website').delete({ where: { id: website.id } });
      await Q('plugin::users-permissions.user').delete({ where: { id: user.id } });
    } catch {}
  };

  const ctrl = strapi.controller('api::publisher-website.publisher-website');

  const mkInitCtx = (user, websiteId, body = {}) => {
    const c = {
      params: { id: String(websiteId) },
      state: { user },
      request: { body },
      _body: null,
      send: function (b) { this._body = b; return b; },
      unauthorized: (m) => { c._err = { code: 401, msg: m }; return null; },
      forbidden:    (m) => { c._err = { code: 403, msg: m }; return null; },
      badRequest:   (m) => { c._err = { code: 400, msg: m }; return null; },
      notFound:     (m) => { c._err = { code: 404, msg: m }; return null; },
      internalServerError: (m) => { c._err = { code: 500, msg: m }; return null; },
    };
    return c;
  };

  const mkCallbackCtx = (signedBody, sig, ts) => {
    const c = {
      request: {
        body: signedBody,
        headers: { 'x-gsc-signature': sig, 'x-gsc-timestamp': ts },
      },
      _body: null,
      send: function (b) { this._body = b; return b; },
      unauthorized: (m) => { c._err = { code: 401, msg: m }; return null; },
      forbidden:    (m) => { c._err = { code: 403, msg: m }; return null; },
      badRequest:   (m) => { c._err = { code: 400, msg: m }; return null; },
      notFound:     (m) => { c._err = { code: 404, msg: m }; return null; },
      internalServerError: (m) => { c._err = { code: 500, msg: m }; return null; },
    };
    return c;
  };

  const signAndCall = async (nonce, properties, opts = {}) => {
    const body = { nonce, properties };
    const canonical = gsc.canonicalJson(body);
    const ts = String(opts.timestamp ?? Date.now());
    const secret = opts.secret ?? process.env.GSC_VERIFY_SHARED_SECRET;
    let sig = crypto.createHmac('sha256', secret).update(`${ts}.${canonical}`).digest('hex');
    if (opts.tamperSig) sig = sig.slice(0, -2) + '00';
    const ctx = mkCallbackCtx(body, sig, ts);
    await ctrl.gscVerifyCallback(ctx);
    return ctx;
  };

  // ----- 1. Happy path -----------------------------------------------------
  out('\n=== 1) HAPPY PATH (sc-domain covers exact host) ===');
  {
    const fx = await mkUserAndWebsite('verify-test-1.example.com');
    // Init
    const initCtx = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(initCtx);
    const nonce = initCtx._body?.nonce;
    assert(typeof nonce === 'string' && nonce.length === 64, 'init returns a nonce');

    // Callback with a matching property
    const cb = await signAndCall(nonce, [{ siteUrl: 'sc-domain:verify-test-1.example.com', permissionLevel: 'siteOwner' }]);
    assert(cb._body?.ok === true, 'callback returns ok');
    const row = await Q('api::publisher-website.publisher-website').findOne({ where: { id: fx.website.id } });
    assert(row.gscVerified === true, 'row.gscVerified == true');
    assert(row.gscPermissionLevel === 'siteOwner', 'permission level recorded');
    assert(row.verificationMethod === 'google-search-console', 'verificationMethod set');
    assert(row.stepCompleted >= 2, 'stepCompleted bumped forward');
    await cleanup(fx);
  }

  // ----- 2. Unowned site (no matching property) ----------------------------
  out('\n=== 2) UNOWNED — no property covers the row ===');
  {
    const fx = await mkUserAndWebsite('verify-test-2.example.com');
    const initCtx = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(initCtx);
    const nonce = initCtx._body.nonce;

    const cb = await signAndCall(nonce, [{ siteUrl: 'sc-domain:something-else.com', permissionLevel: 'siteOwner' }]);
    assert(cb._err?.code === 403, 'forbidden when no property matches');
    const row = await Q('api::publisher-website.publisher-website').findOne({ where: { id: fx.website.id } });
    assert(!row.gscVerified, 'row not marked verified');
    await cleanup(fx);
  }

  // ----- 3. URL-prefix property matches exact host -------------------------
  out('\n=== 3) URL-PREFIX exact host ===');
  {
    const fx = await mkUserAndWebsite('verify-test-3.example.com');
    const initCtx = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(initCtx);
    const cb = await signAndCall(initCtx._body.nonce, [
      { siteUrl: 'https://verify-test-3.example.com/', permissionLevel: 'siteOwner' },
    ]);
    assert(cb._body?.ok === true, 'URL-prefix verified');
    await cleanup(fx);
  }

  // ----- 4. Subdomain — sc-domain covers it; URL-prefix doesn't ------------
  out('\n=== 4) SUBDOMAIN coverage (sc-domain ✓, URL-prefix ✗) ===');
  {
    const fx = await mkUserAndWebsite('blog.verify-test-4.example.com');
    const initCtx = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(initCtx);
    const nonce1 = initCtx._body.nonce;

    // First: URL-prefix on parent → should FAIL
    const cbFail = await signAndCall(nonce1, [
      { siteUrl: 'https://verify-test-4.example.com/', permissionLevel: 'siteOwner' },
    ]);
    assert(cbFail._err?.code === 403, 'URL-prefix on parent does not cover subdomain');

    // New init (the first nonce was consumed)
    const initCtx2 = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(initCtx2);
    const cbOk = await signAndCall(initCtx2._body.nonce, [
      { siteUrl: 'sc-domain:verify-test-4.example.com', permissionLevel: 'siteFullUser' },
    ]);
    assert(cbOk._body?.ok === true, 'sc-domain on parent covers subdomain');
    await cleanup(fx);
  }

  // ----- 5. Cross-account verification — init allowed; callback records
  //          a separate proof and does NOT touch the row. ------------------
  out('\n=== 5) CROSS-ACCOUNT — proof recorded, original row untouched ===');
  {
    const fx = await mkUserAndWebsite('verify-test-5.example.com');
    // Mark the original row as reseller-verified so we can assert it's
    // preserved across a cross-account GSC verification.
    await Q('api::publisher-website.publisher-website').update({
      where: { id: fx.website.id },
      data: { verificationMethod: 'reseller-code', gscVerified: false },
    });
    const otherStamp = `other-${Date.now()}`;
    const otherUser = await Q('plugin::users-permissions.user').create({
      data: { username: otherStamp, email: `${otherStamp}@example.test`, provider: 'local', confirmed: true },
    });

    const beforeRow = await Q('api::publisher-website.publisher-website').findOne({
      where: { id: fx.website.id }, populate: ['currentPublisherId', 'originalPublisherId'],
    });
    const beforeOwnerId = beforeRow.currentPublisherId?.id ?? null;
    const beforeOriginalId = beforeRow.originalPublisherId?.id ?? null;
    const beforeEmail = beforeRow.publisherEmail;
    const beforeMethod = beforeRow.verificationMethod;

    // 5a) Non-owner can init.
    const initCtx = mkInitCtx(otherUser, fx.website.id);
    await ctrl.gscVerifyInit(initCtx);
    assert(typeof initCtx._body?.nonce === 'string', 'non-owner init returns a nonce (no 403)');

    // 5b) Callback succeeds with valid Google proof. Crucially the row is
    //     NOT updated — the proof lives in the cross-account store.
    const cbOk = await signAndCall(initCtx._body.nonce, [
      { siteUrl: 'sc-domain:verify-test-5.example.com', permissionLevel: 'siteOwner' },
    ]);
    assert(cbOk._body?.ok === true, 'cross-account callback returns ok');
    assert(cbOk._body?.crossAccountProofRecorded === true, 'response signals cross-account proof recorded');

    const afterRow = await Q('api::publisher-website.publisher-website').findOne({
      where: { id: fx.website.id }, populate: ['currentPublisherId', 'originalPublisherId'],
    });
    assert(afterRow.gscVerified === false, 'row.gscVerified UNCHANGED (false)');
    assert(afterRow.verificationMethod === beforeMethod, `row.verificationMethod UNCHANGED ('${beforeMethod}')`);
    assert(afterRow.gscVerifiedAt == null, 'row.gscVerifiedAt UNCHANGED (null)');
    assert(afterRow.gscPermissionLevel == null, 'row.gscPermissionLevel UNCHANGED (null)');
    assert((afterRow.currentPublisherId?.id ?? null) === beforeOwnerId, 'currentPublisherId UNCHANGED');
    assert((afterRow.originalPublisherId?.id ?? null) === beforeOriginalId, 'originalPublisherId UNCHANGED');
    assert(afterRow.publisherEmail === beforeEmail, 'publisherEmail UNCHANGED');

    // 5c) The proof IS in the in-memory store, keyed by claimant + URL.
    const proof = gsc.findCrossAccountProof(otherUser.id, 'verify-test-5.example.com');
    assert(proof && proof.gscPermissionLevel === 'siteOwner', 'proof recorded in cross-account store');

    // 5d) Wrong Google proof still rejected.
    const fx2 = await mkUserAndWebsite('verify-test-5b.example.com');
    const initCtx2 = mkInitCtx(otherUser, fx2.website.id);
    await ctrl.gscVerifyInit(initCtx2);
    const cbDeny = await signAndCall(initCtx2._body.nonce, [
      { siteUrl: 'sc-domain:totally-different.com', permissionLevel: 'siteOwner' },
    ]);
    assert(cbDeny._err?.code === 403, 'callback still rejects when Google proof does not cover the URL');
    const denyRow = await Q('api::publisher-website.publisher-website').findOne({ where: { id: fx2.website.id } });
    assert(!denyRow.gscVerified, 'row stays unverified when Google proof is absent');
    assert(gsc.findCrossAccountProof(otherUser.id, 'verify-test-5b.example.com') === null, 'no proof recorded on rejected verification');

    await Q('plugin::users-permissions.user').delete({ where: { id: otherUser.id } });
    await cleanup(fx);
    await cleanup(fx2);
  }

  // ----- 6. Replay — same signature twice ----------------------------------
  out('\n=== 6) REPLAY — duplicate signature rejected ===');
  {
    const fx = await mkUserAndWebsite('verify-test-6.example.com');
    const initCtx = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(initCtx);

    // We need to craft the exact same body+ts+sig and replay it. Easiest:
    // first call succeeds, then we replay the same canonical+ts+sig.
    const body = { nonce: initCtx._body.nonce, properties: [{ siteUrl: 'sc-domain:verify-test-6.example.com', permissionLevel: 'siteOwner' }] };
    const canonical = gsc.canonicalJson(body);
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', process.env.GSC_VERIFY_SHARED_SECRET).update(`${ts}.${canonical}`).digest('hex');

    const cb1 = mkCallbackCtx(body, sig, ts);
    await ctrl.gscVerifyCallback(cb1);
    assert(cb1._body?.ok === true, 'first call succeeds');

    const cb2 = mkCallbackCtx(body, sig, ts);
    await ctrl.gscVerifyCallback(cb2);
    assert(cb2._err?.code === 401, 'replay rejected (401)');
    await cleanup(fx);
  }

  // ----- 7. Idempotency — already verified row, new fresh signature -------
  out('\n=== 7) IDEMPOTENCY — verifying an already-verified row ===');
  {
    const fx = await mkUserAndWebsite('verify-test-7.example.com');
    // First verification
    const init1 = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(init1);
    const cb1 = await signAndCall(init1._body.nonce, [{ siteUrl: 'sc-domain:verify-test-7.example.com', permissionLevel: 'siteOwner' }]);
    assert(cb1._body?.ok === true, 'first verify ok');

    // Second verification with a fresh nonce/signature on the same row
    const init2 = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(init2);
    const cb2 = await signAndCall(init2._body.nonce, [{ siteUrl: 'sc-domain:verify-test-7.example.com', permissionLevel: 'siteOwner' }]);
    assert(cb2._body?.ok === true && cb2._body?.alreadyVerified === true, 'second verify is no-op success');
    await cleanup(fx);
  }

  // ----- 8. Tampered signature ---------------------------------------------
  out('\n=== 8) TAMPERED HMAC — wrong signature rejected ===');
  {
    const fx = await mkUserAndWebsite('verify-test-8.example.com');
    const initCtx = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(initCtx);
    const cb = await signAndCall(initCtx._body.nonce,
      [{ siteUrl: 'sc-domain:verify-test-8.example.com', permissionLevel: 'siteOwner' }],
      { tamperSig: true }
    );
    assert(cb._err?.code === 401, 'bad signature → 401');
    await cleanup(fx);
  }

  // ----- 9. Expired timestamp ----------------------------------------------
  out('\n=== 9) EXPIRED TIMESTAMP — outside 5min window ===');
  {
    const fx = await mkUserAndWebsite('verify-test-9.example.com');
    const initCtx = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(initCtx);
    const cb = await signAndCall(initCtx._body.nonce,
      [{ siteUrl: 'sc-domain:verify-test-9.example.com', permissionLevel: 'siteOwner' }],
      { timestamp: Date.now() - 10 * 60 * 1000 } // 10 min ago
    );
    assert(cb._err?.code === 401, 'expired timestamp → 401');
    await cleanup(fx);
  }

  // ----- 10. Bad nonce -----------------------------------------------------
  out('\n=== 10) BAD NONCE — random nonce not in store ===');
  {
    // Use a random nonce that was never created
    const fakeNonce = crypto.randomBytes(32).toString('hex');
    const cb = await signAndCall(fakeNonce,
      [{ siteUrl: 'sc-domain:anything.com', permissionLevel: 'siteOwner' }]
    );
    assert(cb._err?.code === 401, 'unknown nonce → 401');
  }

  // ----- 11. Wrong secret --------------------------------------------------
  out('\n=== 11) WRONG SECRET — different signing key rejected ===');
  {
    const fx = await mkUserAndWebsite('verify-test-11.example.com');
    const initCtx = mkInitCtx(fx.user, fx.website.id);
    await ctrl.gscVerifyInit(initCtx);
    const cb = await signAndCall(initCtx._body.nonce,
      [{ siteUrl: 'sc-domain:verify-test-11.example.com', permissionLevel: 'siteOwner' }],
      { secret: 'attacker-guessed-secret-' + 'z'.repeat(32) }
    );
    assert(cb._err?.code === 401, 'wrong-secret signature → 401');
    await cleanup(fx);
  }

  // ----- 12. CROSS-ACCOUNT VERIFY → CLAIM (end-to-end) ---------------------
  // Models the spec scenario verbatim:
  //   A added a website via the reseller flow.
  //   B is the actual domain owner, completes GSC verification.
  //   B then submits a claim.
  // Expected: A's row's reseller-code metadata is preserved across both
  // the verification AND the claim. B's NEW row has GSC metadata.
  out('\n=== 12) FULL FLOW: cross-account verify → claim → row A preserved ===');
  {
    // A: original publisher, reseller-added.
    const fxA = await mkUserAndWebsite('verify-test-12.example.com');
    await Q('api::publisher-website.publisher-website').update({
      where: { id: fxA.website.id },
      data: {
        verificationMethod: 'reseller-code',
        addedByReseller: true,
        gscVerified: false,
        submissionStatus: 'approved',
      },
    });

    // B: separate user — the claimant.
    const userB = await Q('plugin::users-permissions.user').create({
      data: {
        username: `b-${Date.now()}`,
        email: `b-${Date.now()}@example.test`,
        provider: 'local',
        confirmed: true,
      },
    });

    // (a) B verifies. Cross-account proof recorded; A's row untouched.
    const initB = mkInitCtx(userB, fxA.website.id);
    await ctrl.gscVerifyInit(initB);
    const cbVerify = await signAndCall(initB._body.nonce, [
      { siteUrl: 'sc-domain:verify-test-12.example.com', permissionLevel: 'siteOwner' },
    ]);
    assert(cbVerify._body?.crossAccountProofRecorded === true, 'verify recorded a cross-account proof');

    const rowAAfterVerify = await Q('api::publisher-website.publisher-website').findOne({ where: { id: fxA.website.id } });
    assert(rowAAfterVerify.verificationMethod === 'reseller-code', "A's verificationMethod still 'reseller-code'");
    assert(rowAAfterVerify.gscVerified === false, "A's gscVerified still false");
    assert(rowAAfterVerify.gscVerifiedAt == null, "A's gscVerifiedAt still null");
    assert(rowAAfterVerify.gscPermissionLevel == null, "A's gscPermissionLevel still null");

    // (b) B submits the claim. Proof is consumed; new row exists for B
    //     with GSC metadata. Note `this` inside arrow functions in an
    //     object literal doesn't bind to the object — use a closure ref.
    const claimCtx = (() => {
      const c = {
        params: { id: String(fxA.website.id) },
        state: { user: userB },
        request: { body: { data: { description: 'test claim', samplePosts: [] } } },
        _body: null,
        _err: null,
        send: (b) => { c._body = b; return b; },
        unauthorized: m => { c._err = { code: 401, msg: m }; },
        forbidden:    m => { c._err = { code: 403, msg: m }; },
        badRequest:   m => { c._err = { code: 400, msg: m }; },
        notFound:     m => { c._err = { code: 404, msg: m }; },
        internalServerError: m => { c._err = { code: 500, msg: m }; },
      };
      return c;
    })();
    await ctrl.claimOwnership(claimCtx);
    const newWebsiteId = claimCtx._body?.data?.newWebsiteId;
    assert(typeof newWebsiteId === 'number', 'claim returned a newWebsiteId');

    // (c) Re-read A's row: still reseller-code, but now marked ownership_claimed.
    const rowAAfterClaim = await Q('api::publisher-website.publisher-website').findOne({ where: { id: fxA.website.id } });
    assert(rowAAfterClaim.verificationMethod === 'reseller-code', "A still 'reseller-code' AFTER claim");
    assert(rowAAfterClaim.gscVerified === false, "A's gscVerified still false AFTER claim");
    assert(rowAAfterClaim.submissionStatus === 'ownership_claimed', "A's status flipped to ownership_claimed");

    // (d) B's new row: gscVerified=true, verificationMethod=google-search-console,
    //     permission level carried from the cross-account proof.
    const rowB = await Q('api::publisher-website.publisher-website').findOne({ where: { id: newWebsiteId } });
    assert(rowB.gscVerified === true, "B's row gscVerified=true");
    assert(rowB.verificationMethod === 'google-search-console', "B's row verificationMethod=google-search-console");
    assert(rowB.gscPermissionLevel === 'siteOwner', "B's row gscPermissionLevel=siteOwner");
    assert(rowB.submissionStatus === 'approval_pending', "B's row in approval_pending");

    // (e) Double-click safety: a second claim by B returns the existing
    //     approval_pending row WITHOUT needing a fresh proof (idempotency).
    const claimCtx2 = (() => {
      const c = {
        params: { id: String(fxA.website.id) },
        state: { user: userB },
        request: { body: { data: { description: 'test claim 2nd' } } },
        _body: null, _err: null,
        send: (b) => { c._body = b; return b; },
        unauthorized: m => { c._err = { code: 401, msg: m }; },
        forbidden:    m => { c._err = { code: 403, msg: m }; },
        badRequest:   m => { c._err = { code: 400, msg: m }; },
        notFound:     m => { c._err = { code: 404, msg: m }; },
        internalServerError: m => { c._err = { code: 500, msg: m }; },
      };
      return c;
    })();
    await ctrl.claimOwnership(claimCtx2);
    assert(claimCtx2._body?.data?.alreadySubmitted === true, 'second claim returns existing claim (idempotent)');
    assert(claimCtx2._body?.data?.newWebsiteId === newWebsiteId, 'second claim references same new row');

    // (f) An unrelated user C with no proof cannot claim.
    const userC = await Q('plugin::users-permissions.user').create({
      data: { username: `c-${Date.now()}`, email: `c-${Date.now()}@example.test`, provider: 'local', confirmed: true },
    });
    const claimCtxC = (() => {
      const c = {
        params: { id: String(fxA.website.id) },
        state: { user: userC },
        request: { body: { data: {} } },
        _body: null, _err: null,
        send: (b) => { c._body = b; return b; },
        unauthorized: m => { c._err = { code: 401, msg: m }; },
        forbidden:    m => { c._err = { code: 403, msg: m }; },
        badRequest:   m => { c._err = { code: 400, msg: m }; },
        notFound:     m => { c._err = { code: 404, msg: m }; },
        internalServerError: m => { c._err = { code: 500, msg: m }; },
      };
      return c;
    })();
    await ctrl.claimOwnership(claimCtxC);
    assert(claimCtxC._err?.code === 400 && /verification first/i.test(claimCtxC._err.msg), 'unrelated user C without proof → 400 verification required');

    // Cleanup
    await Q('api::publisher-website.publisher-website').delete({ where: { id: newWebsiteId } });
    await Q('plugin::users-permissions.user').delete({ where: { id: userB.id } });
    await Q('plugin::users-permissions.user').delete({ where: { id: userC.id } });
    await cleanup(fxA);
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})();
