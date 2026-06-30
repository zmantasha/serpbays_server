#!/usr/bin/env node
/**
 * Verify whether any user can learn the publisher of a marketplace listing
 * through the API.
 *
 * Approach:
 *   1. Pull the real marketplace row for the named domain (default:
 *      themarketersoftware.com).
 *   2. Boot Strapi just enough to load the marketplace controller.
 *   3. Run sanitizePublisherData() against the row as
 *        (a) anonymous / non-owner authenticated user
 *        (b) the owning publisher themselves
 *        (c) an admin
 *      and report exactly which fields are exposed in each case.
 *   4. Static checks: every marketplace read handler (find, findOne, etc.)
 *      actually calls sanitizePublisherData + overrides ctx.query so the
 *      caller can't bypass the strip with ?populate=publisher.
 *
 * Run: node scripts/verify-marketplace-publisher-leak.js [domain]
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');
require('dotenv').config();

const fs = require('fs');
const { Client } = require('pg');

const DOMAIN = process.argv[2] || 'themarketersoftware.com';

// Whitelist of strings considered "publisher PII" — if any of these appear
// in a sanitized response, that's a leak.
const PII_STRINGS = [
  // The username, email, first_name, last_name, business_name of the
  // owner are loaded at runtime so this script also catches a future
  // listing whose owner has a different profile shape.
];

// Fields a leak would look like. We test by KEY presence too (not just
// value), so an empty-string PII field still counts as exposed surface.
const PUBLISHER_PII_KEYS = [
  'publisher_email',
  'publisher_name',
  'publisher_username',
  'publisher_first_name',
  'publisher_last_name',
  'publisher_phone',
  'publisher_business_name',
  'publisher_paypal_email',
  'publisher_payoneer_email',
  // Internal pricing the spec called out as sensitive
  'publisher_price',
  'publisher_link_insertion_price',
  'profit_margin',
  'profitMargin',
];

const SENSITIVE_RELATION_KEYS = ['publisher']; // Should be absent or just {id}

(async () => {
  // ─── Pull the listing + its publisher ─────────────────────────────
  const c = new Client({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });
  await c.connect();

  // Pull every column on the listing — sanitizer must drop the PII ones.
  const r = await c.query(
    `SELECT m.*,
            ml.user_id AS publisher_fk,
            u.username AS pub_username,
            u.email    AS pub_email,
            u.first_name AS pub_first,
            u.last_name  AS pub_last
       FROM marketplaces m
       LEFT JOIN marketplaces_publisher_lnk ml ON ml.marketplace_id = m.id
       LEFT JOIN up_users u ON u.id = ml.user_id
       WHERE m.url ILIKE $1
       LIMIT 1`,
    [`%${DOMAIN}%`]
  );

  if (r.rows.length === 0) {
    console.error(`No marketplace row found for "${DOMAIN}".`);
    process.exit(2);
  }

  const raw = r.rows[0];
  const PUBLISHER_USER = {
    id:        raw.publisher_fk,
    username:  raw.pub_username,
    email:     raw.pub_email,
    firstName: raw.pub_first,
    lastName:  raw.pub_last,
  };
  await c.end();

  // PII strings populated from the real owner — any of these appearing in
  // a sanitized response is a leak.
  for (const v of [
    PUBLISHER_USER.username, PUBLISHER_USER.email,
    PUBLISHER_USER.firstName, PUBLISHER_USER.lastName,
  ]) {
    if (v && String(v).trim().length) PII_STRINGS.push(String(v));
  }

  console.log(`\n=== Listing: ${raw.url} (id=${raw.id}) ===`);
  console.log(`Owner: user.id=${PUBLISHER_USER.id}  username=${PUBLISHER_USER.username}  email=${PUBLISHER_USER.email}`);

  // Strapi-shaped row: pretend the entityService populated `publisher`
  // with the user object (worst case). Anything not in the allow-list
  // should be stripped.
  const populatedRow = {
    ...raw,
    publisher: PUBLISHER_USER, // mimics caller doing ?populate=publisher
  };

  // ─── Load sanitizePublisherData from the controller ───────────────
  // The controller is built via createCoreController — we can't `require`
  // it without bootstrapping Strapi. Use the same Function-factory trick
  // as the test-render scripts.
  const ctrlSrc = fs.readFileSync('src/api/marketplace/controllers/marketplace.js', 'utf8');
  // We only need MARKETPLACE_PUBLIC_FIELDS / MARKETPLACE_OWNER_EXTRA_FIELDS /
  // MARKETPLACE_NEVER_EXPOSE and sanitizePublisherData. Extract them.
  const blocks = [
    ctrlSrc.match(/const MARKETPLACE_PUBLIC_FIELDS\s*=\s*\[[\s\S]*?\];/),
    ctrlSrc.match(/const MARKETPLACE_OWNER_EXTRA_FIELDS\s*=\s*\[[\s\S]*?\];/),
    ctrlSrc.match(/const MARKETPLACE_NEVER_EXPOSE\s*=\s*\[[\s\S]*?\];/),
    // The sanitizer lives inside an object method (`sanitizePublisherData(entries, user)`),
    // not at module top level. Pull just that method body into a function.
    ctrlSrc.match(/sanitizePublisherData\(entries,\s*user\)\s*\{[\s\S]*?\n  \}/),
  ];
  if (blocks.some((b) => !b)) {
    console.error('Could not extract sanitizer source from controller — file shape changed?');
    process.exit(1);
  }
  // Rename the object-method shorthand `sanitizePublisherData(entries, user) {...}`
  // into a function declaration `function sanitize(entries, user) {...}` —
  // that's a syntactically valid top-level form for the Function() body.
  const sanitizerDecl =
    'function sanitize' + blocks[3][0].replace(/^sanitizePublisherData/, '');
  const factorySrc = `
    ${blocks[0][0]}
    ${blocks[1][0]}
    ${blocks[2][0]}
    ${sanitizerDecl}
    return sanitize;
  `;
  const sanitize = new Function(factorySrc)();

  const runCase = (label, user) => {
    // Sanitizer mutates entries — clone for each case.
    const entries = [JSON.parse(JSON.stringify(populatedRow))];
    const out = sanitize(entries, user);
    const row = out[0];
    console.log(`\n--- Case: ${label} ---`);
    console.log(`Returned keys: ${Object.keys(row).join(', ')}`);

    // Check 1: any PII strings present as VALUES?
    const leakedValues = [];
    const stringForm = JSON.stringify(row);
    for (const pii of PII_STRINGS) {
      if (stringForm.includes(pii)) leakedValues.push(pii);
    }

    // Check 2: any sensitive KEYS present?
    const leakedKeys = PUBLISHER_PII_KEYS.filter((k) => k in row);

    // Check 3: publisher relation present?
    const relationPresent = SENSITIVE_RELATION_KEYS.filter((k) => k in row);

    if (leakedValues.length === 0 && leakedKeys.length === 0 && relationPresent.length === 0) {
      console.log('  ✅ No publisher PII leaked.');
    } else {
      if (leakedValues.length) console.log(`  ❌ PII VALUES leaked: ${leakedValues.join(', ')}`);
      if (leakedKeys.length)   console.log(`  ❌ PII KEYS leaked:  ${leakedKeys.join(', ')}`);
      if (relationPresent.length) console.log(`  ⚠️  Relation present: ${relationPresent.join(', ')} — value: ${JSON.stringify(row.publisher)}`);
    }
    return { leakedValues, leakedKeys, relationPresent };
  };

  // ─── The three cases ─────────────────────────────────────────────
  console.log('\n=== Sanitizer simulation ===');

  // A. Anonymous (no user object). The find route is auth-gated so this is
  // mostly hypothetical, but tests sanitizer's safe default.
  const anon = runCase('Anonymous (no user)', null);

  // B. Authenticated non-owner — a different advertiser logged in.
  const other = runCase(
    'Authenticated non-owner (a random advertiser)',
    { id: 999999, email: 'random.advertiser@example.com', role: { type: 'authenticated' } }
  );

  // C. The owning publisher themselves — should see owner-extra fields.
  const owner = runCase(
    'Owning publisher (themselves)',
    { id: PUBLISHER_USER.id, email: PUBLISHER_USER.email, role: { type: 'authenticated' } }
  );

  // D. Admin
  const admin = runCase(
    'Admin',
    { id: 1, email: 'admin@serpbays.com', role: { type: 'admin' } }
  );

  // ─── Static endpoint wiring check ────────────────────────────────
  console.log('\n=== Endpoint wiring ===');

  const fail = [];
  // Both async handlers exist at the expected sites.
  const findIdx    = ctrlSrc.search(/^\s+async find\(ctx\)/m);
  const findOneIdx = ctrlSrc.search(/^\s+async findOne\(ctx\)/m);
  if (findIdx < 0)    fail.push('find handler NOT FOUND in controller');
  if (findOneIdx < 0) fail.push('findOne handler NOT FOUND in controller');
  if (findIdx >= 0)    console.log('  ✅ async find(ctx) defined');
  if (findOneIdx >= 0) console.log('  ✅ async findOne(ctx) defined');

  // Count sanitizePublisherData call sites — every read path that returns
  // marketplace rows must funnel through it.
  const sanCalls = (ctrlSrc.match(/this\.sanitizePublisherData\s*\(/g) || []).length;
  console.log(`  ✅ sanitizePublisherData called from ${sanCalls} site(s) inside the controller`);
  if (sanCalls < 4) {
    fail.push(`expected at least 4 sanitizer call sites (find / findOne / featured / list flavors); found ${sanCalls}`);
  }

  // Caller-controlled `populate` must not survive into the DB query for
  // either find or findOne. Slice each handler's first 2000 chars and
  // confirm there's an explicit `populate:` override before any super call.
  const findBody    = findIdx    >= 0 ? ctrlSrc.slice(findIdx,    findIdx + 4000)    : '';
  const findOneBody = findOneIdx >= 0 ? ctrlSrc.slice(findOneIdx, findOneIdx + 4000) : '';
  for (const [name, body] of [['find', findBody], ['findOne', findOneBody]]) {
    if (!body) continue;
    const overridesPopulate =
      /ctx\.query\s*=\s*\{[\s\S]{0,800}populate:/.test(body) ||
      /populate:\s*\{[\s\S]{0,200}publisher:\s*\{\s*fields:\s*\[\s*['"]id['"]\s*\]/.test(body);
    if (overridesPopulate) {
      console.log(`  ✅ ${name} overrides ctx.query populate (caller can't ?populate=publisher to bypass)`);
    } else {
      fail.push(`${name}: does NOT visibly override populate`);
    }
  }

  fail.forEach((f) => console.log(`  ❌ ${f}`));

  // ─── Summary ─────────────────────────────────────────────────────
  const anyLeak = [anon, other, owner, admin].some(
    (r) => r.leakedValues.length || r.leakedKeys.length
  );
  // Owner / admin showing extra fields is EXPECTED, not a leak — they own
  // the listing or are platform admin. Re-check that the NON-OWNER cases
  // (anon + other) are clean.
  const nonOwnerLeak =
    anon.leakedValues.length || anon.leakedKeys.length ||
    other.leakedValues.length || other.leakedKeys.length;

  console.log('\n=== VERDICT ===');
  if (!nonOwnerLeak && fail.length === 0) {
    console.log(`✅ A non-owner user (anonymous or random authenticated) CANNOT learn`);
    console.log(`   the publisher of "${raw.url}" through the API.`);
    if (owner.leakedKeys.length || owner.leakedValues.length) {
      console.log(`ℹ️  The owning publisher does see additional fields about themselves (expected).`);
    }
    process.exit(0);
  } else {
    console.log(`❌ Publisher PII IS reachable through the API — see leaks above.`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
