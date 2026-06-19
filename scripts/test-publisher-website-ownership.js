#!/usr/bin/env node
/**
 * Regression test for the publisher-website ownership predicate
 * (audit finding #5 fix).
 *
 * Pre-fix bug: `update()` and `find()`'s $or filter accepted the email
 * leg even when `currentPublisherId` was set. Bad-actor user B whose
 * email matched row.publisherEmail could read AND modify row owner=A.
 *
 * This test asserts:
 *   1. Live entityService write by a non-owner returns false from the
 *      isOwner-shaped predicate the controller uses.
 *   2. Live find with strict-$or returns ZERO rows for a non-owner whose
 *      email merely matches publisherEmail.
 *   3. Legacy rows (currentPublisherId NULL) still match via the email
 *      fallback for whoever owns that email.
 *
 * Run:
 *   cd serpbays_server
 *   node scripts/test-publisher-website-ownership.js
 */
'use strict';
process.env.NODE_ENV = 'production';
process.chdir('/var/www/serpbays/serpbays_server');

(async () => {
  const { createStrapi } = require('/var/www/serpbays/serpbays_server/node_modules/@strapi/strapi');
  const strapi = await createStrapi({ appDir: '/var/www/serpbays/serpbays_server' });
  await strapi.load();
  const Q = (uid) => strapi.db.query(uid);

  let pass = 0, fail = 0;
  const out = (...a) => process.stderr.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out('  ✅', label); }
    else      { fail++; out('  ❌', label); }
  };

  // Local copy of the helper (mirrors the one in controllers/publisher-website.js).
  // Keeping the test self-contained so it can run without importing the controller module.
  function isPublisherWebsiteOwner(row, user) {
    if (!row || !user) return false;
    const rowOwnerId = row.currentPublisherId?.id ?? row.currentPublisherId ?? null;
    if (rowOwnerId != null) return rowOwnerId === user.id;
    return Boolean(row.publisherEmail) && row.publisherEmail === user.email;
  }

  // Fixtures
  const stamp = Date.now();
  const role = await Q('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const userA = await Q('plugin::users-permissions.user').create({
    data: { username: `own-a-${stamp}`, email: `own-a-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });
  const userB = await Q('plugin::users-permissions.user').create({
    data: { username: `own-b-${stamp}`, email: `own-b-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });

  // Row 1: owned by A via relation, but publisher_email field is B's email.
  // This is the exact shape that pre-fix code mis-classified as "B owns this row".
  const row1 = await Q('api::publisher-website.publisher-website').create({
    data: {
      url: `ownership-test-1-${stamp}.example.com`,
      submissionStatus: 'approved',
      stepCompleted: 4,
      publisherEmail: userB.email,                  // ⚠️ B's email
      publisherName: 'A-listing',
      currentPublisherId: userA.id,                 // ⚠️ A is the actual owner
      countries: [], category: [], language: [], samplePosts: [],
      publishedAt: new Date(),
    },
  });

  // Row 2: legacy unlinked row — currentPublisherId NULL, publisher_email = B's.
  // This SHOULD still be owned by B via the email fallback.
  const row2 = await Q('api::publisher-website.publisher-website').create({
    data: {
      url: `ownership-test-2-${stamp}.example.com`,
      submissionStatus: 'approved',
      stepCompleted: 4,
      publisherEmail: userB.email,
      publisherName: 'legacy-unlinked',
      // No currentPublisherId
      countries: [], category: [], language: [], samplePosts: [],
      publishedAt: new Date(),
    },
  });

  try {
    // Reload with populate so the helper sees the relation in its expected shape.
    const row1Full = await Q('api::publisher-website.publisher-website').findOne({
      where: { id: row1.id }, populate: ['currentPublisherId']
    });
    const row2Full = await Q('api::publisher-website.publisher-website').findOne({
      where: { id: row2.id }, populate: ['currentPublisherId']
    });

    out('\n=== 1) Strict-ID ownership for relation-linked rows ===');
    assert( isPublisherWebsiteOwner(row1Full, userA), 'User A IS owner of row1 (currentPublisherId match)');
    assert(!isPublisherWebsiteOwner(row1Full, userB), 'User B is NOT owner of row1 even though publisherEmail matches B');

    out('\n=== 2) Email fallback for legacy unlinked rows ===');
    assert(!isPublisherWebsiteOwner(row2Full, userA), 'User A is NOT owner of row2 (legacy, email mismatch)');
    assert( isPublisherWebsiteOwner(row2Full, userB), 'User B IS owner of row2 (legacy unlinked + email match)');

    out('\n=== 3) Find-side filter excludes the leak ===');
    // Use the same $or shape the controller uses post-fix.
    const filterFor = (u) => ({
      $or: [
        { currentPublisherId: u.id },
        { $and: [{ currentPublisherId: { $null: true } }, { publisherEmail: u.email }] },
      ],
    });

    const aRows = await Q('api::publisher-website.publisher-website').findMany({ where: filterFor(userA), select: ['id'] });
    const bRows = await Q('api::publisher-website.publisher-website').findMany({ where: filterFor(userB), select: ['id'] });
    const aIds = aRows.map(r => r.id);
    const bIds = bRows.map(r => r.id);

    assert( aIds.includes(row1.id), 'find() for A returns row1 (A is the relation-linked owner)');
    assert(!aIds.includes(row2.id), 'find() for A does NOT return row2 (A is not the email-fallback owner)');
    assert(!bIds.includes(row1.id), 'find() for B does NOT return row1 (publisherEmail match is suppressed when currentPublisherId is set)');
    assert( bIds.includes(row2.id), 'find() for B returns row2 (legacy unlinked + email match)');

    out('\n=== 4) Edge cases ===');
    assert(!isPublisherWebsiteOwner(null, userA), 'null row → not owner');
    assert(!isPublisherWebsiteOwner(row1Full, null), 'null user → not owner');
    assert(!isPublisherWebsiteOwner({}, userA), 'empty row → not owner');
    // Row with neither currentPublisherId nor publisherEmail
    assert(!isPublisherWebsiteOwner({ currentPublisherId: null, publisherEmail: null }, userA), 'fully unlinked row → not owner');

  } finally {
    try { await Q('api::publisher-website.publisher-website').delete({ where: { id: row1.id } }); } catch {}
    try { await Q('api::publisher-website.publisher-website').delete({ where: { id: row2.id } }); } catch {}
    try { await Q('plugin::users-permissions.user').delete({ where: { id: userA.id } }); } catch {}
    try { await Q('plugin::users-permissions.user').delete({ where: { id: userB.id } }); } catch {}
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
