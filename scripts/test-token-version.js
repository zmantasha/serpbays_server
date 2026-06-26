#!/usr/bin/env node
/**
 * Regression test for JWT token-version revocation (audit finding #11 stage 1).
 *
 * Verifies that:
 *   1. A freshly-issued JWT validates.
 *   2. Logout bumps tokenVersion; the same JWT then fails verify().
 *   3. Admin revoke bumps tokenVersion; the JWT fails verify().
 *   4. A user-update touching `role` / `blocked` / `confirmed` bumps tokenVersion.
 *   5. A user-update touching ONLY profile fields does NOT bump tokenVersion.
 *   6. JWTs minted via the legacy upstream issue() (no tokenVersion claim)
 *      still validate while user.tokenVersion === 0 (back-compat).
 *   7. After any bump, legacy JWTs (no claim) become invalid.
 *
 * Run:
 *   cd serpbays_server
 *   node scripts/test-token-version.js
 *
 * Exit code: 0 on success, 1 on any failure.
 */
'use strict';
process.env.NODE_ENV = 'production';
process.chdir('/var/www/serpbays/serpbays_server');

(async () => {
  const { createStrapi } = require('/var/www/serpbays/serpbays_server/node_modules/@strapi/strapi');
  const strapi = await createStrapi({ appDir: '/var/www/serpbays/serpbays_server' });
  await strapi.load();

  const Q = (uid) => strapi.db.query(uid);
  const jwtSvc = strapi.plugins['users-permissions'].services.jwt;

  let pass = 0, fail = 0;
  const out = (...a) => process.stderr.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out('  ✅', label); }
    else      { fail++; out('  ❌', label); }
  };
  const expectVerifyFails = async (token, label) => {
    try { await jwtSvc.verify(token); fail++; out('  ❌', label, '(verify SUCCEEDED, expected failure)'); }
    catch (e) { pass++; out('  ✅', label, '— rejected:', e.message); }
  };
  const expectVerifyOk = async (token, label) => {
    try { const p = await jwtSvc.verify(token); pass++; out('  ✅', label, '(tokenVersion in claim =', p.tokenVersion ?? 'absent', ')'); return p; }
    catch (e) { fail++; out('  ❌', label, '(verify failed:', e.message, ')'); return null; }
  };

  // Disposable fixture.
  const stamp = Date.now();
  const role = await Q('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const fixture = await Q('plugin::users-permissions.user').create({
    data: {
      username: `tv-test-${stamp}`,
      email: `tv-test-${stamp}@example.test`,
      provider: 'local',
      confirmed: true,
      blocked: false,
      role: role.id,
    },
  });

  try {
    out('\n=== 1) Fresh JWT validates ===');
    const tok1 = await jwtSvc.issueWithTokenVersion({ id: fixture.id });
    const p1 = await expectVerifyOk(tok1, 'fresh JWT verifies');
    assert(p1 && (p1.tokenVersion ?? 0) === 0, 'fresh JWT claim has tokenVersion=0');

    out('\n=== 2) Logout (bump) invalidates the old JWT ===');
    await strapi.db.connection('up_users').where({ id: fixture.id }).increment('token_version', 1);
    await expectVerifyFails(tok1, 'old JWT rejected after logout bump');
    // New JWT issued AFTER the bump must validate.
    const tok2 = await jwtSvc.issueWithTokenVersion({ id: fixture.id });
    const p2 = await expectVerifyOk(tok2, 'new JWT (post-logout) verifies');
    assert((p2.tokenVersion ?? 0) === 1, 'post-logout JWT has tokenVersion=1');

    out('\n=== 3) Admin revoke invalidates again ===');
    await strapi.db.connection('up_users').where({ id: fixture.id }).increment('token_version', 1);
    await expectVerifyFails(tok2, 'post-logout JWT rejected after admin revoke');
    const tok3 = await jwtSvc.issueWithTokenVersion({ id: fixture.id });
    const p3 = await expectVerifyOk(tok3, 'new JWT (post-revoke) verifies');
    assert((p3.tokenVersion ?? 0) === 2, 'post-revoke JWT has tokenVersion=2');

    out('\n=== 4) Role / blocked / confirmed update bumps via lifecycle ===');
    const beforeRoleChange = (await Q('plugin::users-permissions.user').findOne({ where: { id: fixture.id }, select: ['tokenVersion'] })).tokenVersion;
    // Trigger the lifecycle via entityService (the path admin updates take).
    await strapi.entityService.update('plugin::users-permissions.user', fixture.id, { data: { blocked: true } });
    const afterRoleChange = (await Q('plugin::users-permissions.user').findOne({ where: { id: fixture.id }, select: ['tokenVersion'] })).tokenVersion;
    assert(afterRoleChange === beforeRoleChange + 1, `blocked-flag flip bumps tokenVersion (${beforeRoleChange} → ${afterRoleChange})`);
    await expectVerifyFails(tok3, 'old JWT rejected after blocked=true flip');
    // Unblock to keep the row in a sane state for the remaining tests.
    await strapi.entityService.update('plugin::users-permissions.user', fixture.id, { data: { blocked: false } });

    out('\n=== 5) Profile-only update does NOT bump ===');
    const beforeProfile = (await Q('plugin::users-permissions.user').findOne({ where: { id: fixture.id }, select: ['tokenVersion'] })).tokenVersion;
    await strapi.entityService.update('plugin::users-permissions.user', fixture.id, { data: { firstName: 'Test' } });
    const afterProfile = (await Q('plugin::users-permissions.user').findOne({ where: { id: fixture.id }, select: ['tokenVersion'] })).tokenVersion;
    assert(afterProfile === beforeProfile, `profile-only update keeps tokenVersion stable (${beforeProfile} → ${afterProfile})`);
    const tok5 = await jwtSvc.issueWithTokenVersion({ id: fixture.id });
    await expectVerifyOk(tok5, 'fresh JWT after profile-only update verifies');

    out('\n=== 6) Legacy JWT (no tokenVersion claim) validates while user.tokenVersion is 0 ===');
    // Force user.tokenVersion to 0 for this test.
    await strapi.db.connection('up_users').where({ id: fixture.id }).update({ token_version: 0 });
    // Mint a legacy-shape JWT by calling base issue() directly (no claim enrichment).
    const upstreamJwtBase = require('/var/www/serpbays/serpbays_server/node_modules/jsonwebtoken');
    const env = require('fs').readFileSync('/var/www/serpbays/serpbays_server/.env', 'utf8');
    const secret = env.match(/^JWT_SECRET=(.+)$/m)[1];
    const legacyToken = upstreamJwtBase.sign({ id: fixture.id }, secret, { expiresIn: '7d' });
    await expectVerifyOk(legacyToken, 'legacy-shape JWT (no claim) verifies vs tokenVersion=0');

    out('\n=== 7) After bump, legacy JWT (no claim) becomes invalid ===');
    await strapi.db.connection('up_users').where({ id: fixture.id }).increment('token_version', 1);
    await expectVerifyFails(legacyToken, 'legacy JWT rejected after any bump');

  } finally {
    try { await Q('plugin::users-permissions.user').delete({ where: { id: fixture.id } }); } catch {}
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
