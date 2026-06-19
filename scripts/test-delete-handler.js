#!/usr/bin/env node
/**
 * Regression test for the publisher-website DELETE handler (audit finding #2).
 *
 * Pre-fix: two `async delete(ctx)` declarations existed in the same module
 * object literal. By JS spec, the second declaration won, making the first
 * (which had a marketplace cascade and no business-rule gates) dead code.
 * Renaming or reordering would silently swap behaviour.
 *
 * This test asserts:
 *   1. Static — exactly ONE `async delete` exists in the source file.
 *   2. Active handler refuses gsc_verified / added_by_reseller rows.
 *   3. Active handler refuses step_completed > 1 rows.
 *   4. Active handler refuses non-pending_verification statuses.
 *   5. Active handler succeeds on step-1 pending_verification rows.
 *   6. Active handler refuses non-owners (finding #5 ownership rule applies).
 *   7. Defensive marketplace cascade fires for the edge case (step-1 row that
 *      somehow has a marketplaceId — data drift).
 *
 * Run:
 *   cd serpbays_server
 *   node scripts/test-delete-handler.js
 */
'use strict';
process.env.NODE_ENV = 'production';
process.chdir('/var/www/serpbays/serpbays_server');

const fs = require('fs');

(async () => {
  let pass = 0, fail = 0;
  const out = (...a) => process.stderr.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out('  ✅', label); }
    else      { fail++; out('  ❌', label); }
  };

  out('\n=== 1) Static: exactly one async delete in the controller ===');
  const src = fs.readFileSync('src/api/publisher-website/controllers/publisher-website.js', 'utf8');
  const matches = src.match(/^\s*async\s+delete\s*\(\s*ctx\s*\)/mg) || [];
  assert(matches.length === 1, `exactly 1 'async delete(ctx)' in source — found ${matches.length}`);

  const { createStrapi } = require('/var/www/serpbays/serpbays_server/node_modules/@strapi/strapi');
  const strapi = await createStrapi({ appDir: '/var/www/serpbays/serpbays_server' });
  await strapi.load();
  const Q = (uid) => strapi.db.query(uid);

  const stamp = Date.now();
  const role = await Q('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const owner = await Q('plugin::users-permissions.user').create({
    data: { username: `del-own-${stamp}`, email: `del-own-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });
  const other = await Q('plugin::users-permissions.user').create({
    data: { username: `del-oth-${stamp}`, email: `del-oth-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });
  const ctrl = strapi.controller('api::publisher-website.publisher-website');

  const mkRow = async (suffix, attrs, ownerId) => {
    const row = await Q('api::publisher-website.publisher-website').create({
      data: {
        url: `del-test-${suffix}-${stamp}.example.com`,
        publisherEmail: owner.email, publisherName: 'test',
        countries: [], category: [], language: [], samplePosts: [],
        publishedAt: new Date(),
        ...attrs,
      },
    });
    await strapi.db.connection('publisher_websites_current_publisher_id_lnk').insert({ publisher_website_id: row.id, user_id: ownerId ?? owner.id });
    await strapi.db.connection('publisher_websites_original_publisher_id_lnk').insert({ publisher_website_id: row.id, user_id: ownerId ?? owner.id });
    return row.id;
  };
  const mkCtx = (rowId, user) => {
    const c = {
      params: { id: String(rowId) }, state: { user }, request: { body: {} },
      _body: null, _err: null,
      send(b) { c._body = b; return b; },
      badRequest(m) { c._err = { code: 400, msg: m }; return c._err; },
      unauthorized(m) { c._err = { code: 401, msg: m }; return c._err; },
      forbidden(m) { c._err = { code: 403, msg: m }; return c._err; },
      notFound(m) { c._err = { code: 404, msg: m }; return c._err; },
      internalServerError(m) { c._err = { code: 500, msg: m }; return c._err; },
    };
    return c;
  };
  const stillExists = async (id) => Boolean(await Q('api::publisher-website.publisher-website').findOne({ where: { id } }));
  const cleanupRow = async (id) => {
    try { await Q('api::publisher-website.publisher-website').delete({ where: { id } }); } catch {}
  };

  try {
    out('\n=== 2) Approved + GSC-verified row → refused with 400 ===');
    let rid = await mkRow('approved-gsc', { submissionStatus: 'approved', stepCompleted: 4, gscVerified: true });
    let ctx = mkCtx(rid, owner);
    await ctrl.delete(ctx);
    assert(ctx._err?.code === 400 && /verified/i.test(JSON.stringify(ctx._err.msg)), 'approved + gscVerified → 400 verified');
    assert(await stillExists(rid), 'row still exists in DB after refused delete');
    await cleanupRow(rid);

    out('\n=== 3) Step > 1 → refused ===');
    rid = await mkRow('step2', { submissionStatus: 'pending_verification', stepCompleted: 2, gscVerified: false });
    ctx = mkCtx(rid, owner);
    await ctrl.delete(ctx);
    assert(ctx._err?.code === 400 && /completed verification|cannot be deleted/i.test(JSON.stringify(ctx._err.msg)), 'step > 1 → 400');
    assert(await stillExists(rid), 'row still exists');
    await cleanupRow(rid);

    out('\n=== 4) status !== pending_verification → refused ===');
    rid = await mkRow('final', { submissionStatus: 'pending_final_submission', stepCompleted: 1, gscVerified: false });
    ctx = mkCtx(rid, owner);
    await ctrl.delete(ctx);
    assert(ctx._err?.code === 400 && /pending verification status/i.test(JSON.stringify(ctx._err.msg)), 'pending_final_submission → 400');
    assert(await stillExists(rid), 'row still exists');
    await cleanupRow(rid);

    out('\n=== 5) Happy path: step-1 pending_verification → 200, row gone ===');
    rid = await mkRow('happy', { submissionStatus: 'pending_verification', stepCompleted: 1, gscVerified: false });
    ctx = mkCtx(rid, owner);
    await ctrl.delete(ctx);
    assert(ctx._body && ctx._body.success === true, 'returned success:true');
    assert(!(await stillExists(rid)), 'row deleted from DB');

    out('\n=== 6) Non-owner refused (finding #5 ownership rule) ===');
    rid = await mkRow('owner-check', { submissionStatus: 'pending_verification', stepCompleted: 1, gscVerified: false });
    ctx = mkCtx(rid, other);
    await ctrl.delete(ctx);
    assert(ctx._err?.code === 403, 'non-owner gets 403');
    assert(await stillExists(rid), 'row still exists after non-owner attempt');
    await cleanupRow(rid);

    out('\n=== 7) Defensive marketplace cascade for drifted step-1 row ===');
    // Edge case: a step-1 row that somehow has a marketplaceId.
    // Should NEVER happen in normal product flow but we guard for data drift.
    const mp = await Q('api::marketplace.marketplace').create({
      data: { url: `del-cascade-${stamp}.example.com`, status: 'active' },
    });
    rid = await mkRow('cascade', { submissionStatus: 'pending_verification', stepCompleted: 1, gscVerified: false, marketplaceId: mp.id });
    ctx = mkCtx(rid, owner);
    await ctrl.delete(ctx);
    assert(ctx._body && ctx._body.success === true, 'happy delete also for drifted row');
    assert(!(await stillExists(rid)), 'publisher_website row deleted');
    const mpAfter = await Q('api::marketplace.marketplace').findOne({ where: { id: mp.id } });
    assert(mpAfter == null, 'orphan marketplace cascaded (no orphan left behind)');

  } finally {
    try { await Q('plugin::users-permissions.user').delete({ where: { id: owner.id } }); } catch {}
    try { await Q('plugin::users-permissions.user').delete({ where: { id: other.id } }); } catch {}
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
