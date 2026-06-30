#!/usr/bin/env node
/**
 * Regression test — PII pass 5 (marketplace IDOR + allow-list).
 *
 * Static-grep checks that /api/marketplaces and its custom routes
 * never leak publisher PII (email, name, intake pricing), internal
 * admin state, or the populated `publisher` user record to non-owners.
 *
 * The pre-fix code used a deny-list (`key.startsWith('publisher_')`)
 * which (a) missed the populated `publisher` relation field — the
 * full up_users row leaked through every /api/marketplaces response
 * to every authenticated user — and (b) would silently let any new
 * schema column leak by default.
 *
 * Run: cd serpbays_server && node scripts/test-pii-pass5.js
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');

const fs = require('fs');
let pass = 0, fail = 0;
const out = (...a) => process.stderr.write(a.join(' ') + '\n');
const assert = (cond, label) => {
  if (cond) { pass++; out('  PASS', label); }
  else      { fail++; out('  FAIL', label); }
};
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const stripJsComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const MP_CTRL   = read('src/api/marketplace/controllers/marketplace.js');
const MP_ROUTES = read('src/api/marketplace/routes/marketplace.js');
const MP_CUSTOM = read('src/api/marketplace/routes/custom.js');
const MP_CTRL_NO_COMMENTS = stripJsComments(MP_CTRL);

out('\n=== A. Allow-list constants exist + are strict ===');

// A1. Constants defined
for (const name of ['MARKETPLACE_PUBLIC_FIELDS', 'MARKETPLACE_OWNER_EXTRA_FIELDS', 'MARKETPLACE_NEVER_EXPOSE']) {
  assert(new RegExp(`const ${name}\\s*=\\s*\\[`).test(MP_CTRL),
    `${name} constant defined`);
}

// A2. PUBLIC_FIELDS must NOT contain any publisher_* intake pricing
{
  const m = MP_CTRL.match(/const MARKETPLACE_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const list = m ? stripJsComments(m[1]) : '';
  for (const bad of [
    'publisher_email', 'publisher_name',
    'publisher_price', 'publisher_writing_price',
    'publisher_link_insertion_price',
    'publisher_casino_pricing', 'publisher_cbd_pricing',
    'publisher_crypto_pricing', 'publisher_dating_pricing',
    'publisher_forbidden_gp_price', 'publisher_forbidden_li_price',
    'gsc_refresh_token', 'gsc_permission_level',
    'approvalStatus', 'blacklist_status', 'dataVersion',
  ]) {
    assert(!new RegExp(`['"]${bad}['"]`).test(list),
      `MARKETPLACE_PUBLIC_FIELDS does NOT contain '${bad}'`);
  }
}

// A3. NEVER_EXPOSE must contain gsc_refresh_token
{
  const m = MP_CTRL.match(/const MARKETPLACE_NEVER_EXPOSE\s*=\s*\[([\s\S]*?)\]/);
  const list = m ? m[1] : '';
  assert(/['"]gsc_refresh_token['"]/.test(list),
    "MARKETPLACE_NEVER_EXPOSE includes 'gsc_refresh_token'");
}

out('\n=== B. sanitizePublisherData uses allow-list (not deny-list) ===');

// B1. The old deny-list pattern is gone
assert(!/key\.startsWith\(['"]publisher_['"]/.test(MP_CTRL_NO_COMMENTS),
  "no deny-list `key.startsWith('publisher_')` pattern remains");

// B2. Sanitizer iterates the allow-list constants
{
  const fn = MP_CTRL.match(/sanitizePublisherData\(entries, user\)[\s\S]*?^  \},/m);
  const body = fn ? fn[0] : '';
  assert(/for\s*\(\s*const\s+k\s+of\s+allowedFields\)/.test(body),
    'sanitizer iterates allowedFields (allow-list)');
  assert(/\.\.\.\s*MARKETPLACE_PUBLIC_FIELDS/.test(body),
    'allowedFields composes from MARKETPLACE_PUBLIC_FIELDS');
  assert(/\.\.\.\s*MARKETPLACE_OWNER_EXTRA_FIELDS/.test(body),
    'owner gets MARKETPLACE_OWNER_EXTRA_FIELDS added');
  assert(/MARKETPLACE_NEVER_EXPOSE/.test(body),
    'sanitizer enforces MARKETPLACE_NEVER_EXPOSE strip even on allow-list path');
  assert(/isOwnWebsite/.test(body),
    'sanitizer computes + returns isOwnWebsite flag');
}

out('\n=== C. find() populate scope (publisher relation must be id-only) ===');

// C1. No string-form populate of publisher in find() / findOne()
//     (`populate: ['publisher']` returns the full up_users row)
{
  // Find every occurrence of `populate: ['publisher']` in code (excl. comments)
  const matches = (MP_CTRL_NO_COMMENTS.match(/populate:\s*\[\s*['"]publisher['"]/g) || []).length;
  assert(matches === 0,
    `no string-form populate of publisher in code (found: ${matches})`);
}

// C2. No `populate: '*'` (caller-controlled or default) in user-facing paths
assert(!/populate:\s*ctx\.query\.populate/.test(MP_CTRL_NO_COMMENTS),
  'no caller-controlled `populate: ctx.query.populate`');
assert(!/populate:\s*['"]\*['"]/.test(MP_CTRL_NO_COMMENTS),
  "no `populate: '*'` (everything-populate) in code");

// C3. publisher populate uses fields:['id'] or select:['id']
{
  // Count expected pattern vs unexpected broad pattern
  const safeCount = (MP_CTRL_NO_COMMENTS.match(/populate:\s*\{\s*publisher:\s*\{\s*(fields|select):\s*\[\s*['"]id['"]/g) || []).length;
  assert(safeCount >= 2,
    `at least 2 places use the safe { publisher: { fields/select: ['id'] } } shape (found: ${safeCount})`);
}

out('\n=== D. Admin gate on /marketplaces/upload-csv (was is-authenticated) ===');

// D1. The upload-csv route uses admin-jwt-auth + is-admin
{
  const block = MP_ROUTES.match(/path:\s*['"]\/marketplaces\/upload-csv['"][\s\S]{0,400}\},/);
  const body = block ? block[0] : '';
  assert(/global::is-admin/.test(body),
    "/marketplaces/upload-csv uses 'global::is-admin' policy");
  assert(/global::admin-jwt-auth/.test(body),
    "/marketplaces/upload-csv uses 'global::admin-jwt-auth' middleware");
  assert(!/global::is-authenticated/.test(body),
    "/marketplaces/upload-csv no longer uses is-authenticated (any-user) policy");
}

// D2. The 5 routes in custom.js are admin-gated (regression check on prior state)
{
  for (const pathName of [
    '/upload-csv',
    '/marketplaces/export-csv',
    '/marketplaces/export-selected-csv',
    '/marketplaces/admin-list',
    '/marketplaces/export-filtered-csv',
  ]) {
    const escapedPath = pathName.replace(/\//g, '\\/');
    const re = new RegExp(`path:\\s*['"]${escapedPath}['"][\\s\\S]{0,400}global::admin-jwt-auth`);
    assert(re.test(MP_CUSTOM),
      `${pathName} is admin-gated via admin-jwt-auth middleware`);
  }
}

out('\n=== E. Schema conformance ===');

// E1. Every name in MARKETPLACE_PUBLIC_FIELDS + OWNER_EXTRA must exist
//     on the marketplace schema (catches the balanceAfter / publishedAt
//     class of bug)
{
  const schema = require('/var/www/serpbays/serpbays_server/src/api/marketplace/content-types/marketplace/schema.json');
  const validAttrs = new Set([
    'id', 'documentId', 'createdAt', 'updatedAt',
    ...Object.keys(schema.attributes),
  ]);
  if (schema.options?.draftAndPublish) validAttrs.add('publishedAt');

  const pickList = (name) => {
    const m = MP_CTRL.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    if (!m) return [];
    return Array.from(stripJsComments(m[1]).matchAll(/['"]([^'"]+)['"]/g)).map(x => x[1]);
  };

  for (const constName of ['MARKETPLACE_PUBLIC_FIELDS', 'MARKETPLACE_OWNER_EXTRA_FIELDS', 'MARKETPLACE_NEVER_EXPOSE']) {
    const declared = pickList(constName);
    const bogus = declared.filter(k => !validAttrs.has(k));
    assert(bogus.length === 0,
      `${constName}: every name exists on schema (bogus: [${bogus.join(', ')}])`);
  }
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
