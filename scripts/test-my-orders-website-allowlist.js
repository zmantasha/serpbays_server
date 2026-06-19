#!/usr/bin/env node
/**
 * Regression test: GET /api/orders/my-orders no longer leaks publisher
 * private fields, GSC secrets, or internal admin/operational state via the
 * populated `website` relation.
 *
 * Pre-fix: controllers/order.js getMyOrders used `populate: { website: true }`
 *   → returned 80+ fields on the marketplace row, bypassing the marketplace's
 *   privateAttributes config and exposing publisher_email, publisher_*_pricing
 *   intake prices, gsc_refresh_token, gsc_permission_level, plus internal
 *   admin state (approvalStatus, blacklist_status, dataVersion,
 *   bulkRefreshSkipTools, last*RefreshAt/last*ExportAt).
 *
 * Post-fix: an explicit allow-list (WEBSITE_PUBLIC_FIELDS) constrains the
 * populate; populate now uses `{ fields: WEBSITE_PUBLIC_FIELDS }`. Allow-list
 * approach means new fields added to the marketplace schema are NOT exposed
 * automatically — they must be explicitly added before they appear.
 *
 * Also asserts the order-row snapshot strip (websitePublisherEmail/Name/Price
 * removed when caller is NOT the publisher of that order) and the cart.js
 * `publisher_writing_price` removal.
 *
 * Static-grep test — no Strapi load.
 *
 * Run: cd serpbays_server && node scripts/test-my-orders-website-allowlist.js
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');

const fs = require('fs');
let pass = 0, fail = 0;
const out = (...a) => process.stderr.write(a.join(' ') + '\n');
const assert = (cond, label) => {
  if (cond) { pass++; out('  ✅', label); }
  else      { fail++; out('  ❌', label); }
};
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const ORDER_CTRL = 'src/api/order/controllers/order.js';
const CART_CTRL = 'src/api/cart/controllers/cart.js';
const ctrl = read(ORDER_CTRL);
const cart = read(CART_CTRL);

out('\n=== 1) WEBSITE_PUBLIC_FIELDS allow-list defined ===');
assert(/const\s+WEBSITE_PUBLIC_FIELDS\s*=\s*\[/.test(ctrl),
  'WEBSITE_PUBLIC_FIELDS constant defined');
// Slice the allow-list literal so we can assert exclusions cleanly
const allowListMatch = ctrl.match(/const\s+WEBSITE_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\];/);
const allowListBody = allowListMatch ? allowListMatch[1] : '';
assert(allowListBody.length > 0, 'WEBSITE_PUBLIC_FIELDS literal sliced');

out('\n=== 2) Required advertiser-facing fields present in allow-list ===');
for (const expected of [
  "'id'", "'url'", "'price'", "'link_insertion_price'",
  "'tat'", "'category'", "'language'", "'countries'",
  "'ahrefs_dr'", "'ahrefs_traffic'", "'moz_da'",
  "'backlink_type'", "'min_word_count'",
  "'gsc_verified'", "'sponsored'", "'ugc'",
  "'isFeatured'", "'isFeaturedGuestPost'", "'isFeaturedLinkInsertion'",
]) {
  assert(allowListBody.includes(expected), `${expected} included (advertiser-facing field)`);
}

out('\n=== 3) Sensitive fields EXCLUDED from allow-list ===');
// Every field listed in the user's spec must NOT appear in the allow-list.
// We check on the quoted form to avoid false positives from substring matches.
const FORBIDDEN_IN_ALLOWLIST = [
  // PII + intake-price publisher_* fields
  'publisher_email', 'publisher_name',
  'publisher_price', 'publisher_writing_price', 'publisher_link_insertion_price',
  'publisher_forbidden_gp_price', 'publisher_forbidden_li_price',
  'publisher_casino_pricing', 'publisher_cbd_pricing',
  'publisher_crypto_pricing', 'publisher_dating_pricing',
  'publisher_li_casino_pricing', 'publisher_li_cbd_pricing',
  'publisher_li_crypto_pricing', 'publisher_li_dating_pricing',
  // GSC secrets (gsc_verified is OK as a public flag; the others are not)
  'gsc_refresh_token', 'gsc_permission_level',
  // Internal admin + moderation state
  'approvalStatus', 'blacklist_status', 'delistedReason', 'delistedAt',
  'dataVersion', 'bulkRefreshSkipTools',
  // Operational metadata (data-provider refresh / export timestamps)
  'lastAhrefsRefreshAt', 'lastAhrefsExportAt',
  'lastMozRefreshAt', 'lastMozExportAt',
  'lastSemrushRefreshAt', 'lastSemrushExportAt',
];
for (const banned of FORBIDDEN_IN_ALLOWLIST) {
  assert(
    !new RegExp(`['"]${banned}['"]`).test(allowListBody),
    `'${banned}' is NOT in WEBSITE_PUBLIC_FIELDS (must stay private)`
  );
}

out('\n=== 4) getMyOrders populate uses the allow-list, NOT `website: true` ===');
// Slice the getMyOrders body
const gmoStart = ctrl.indexOf('async getMyOrders(ctx)');
const gmoEnd   = ctrl.indexOf('async getCounts(ctx)');
const gmoBody  = gmoStart > 0 && gmoEnd > gmoStart ? ctrl.slice(gmoStart, gmoEnd) : '';
assert(gmoBody.length > 0, 'getMyOrders body sliced');
// Forbid the old pattern as ACTUAL CODE, not in comment lines. A simple
// heuristic: split on lines, drop everything after `//`, then re-check.
const codeLines = gmoBody.split('\n').map((ln) => ln.replace(/\/\/.*$/, ''));
const gmoCode = codeLines.join('\n');
assert(!/website:\s*true/.test(gmoCode),
  'no `website: true` populate inside getMyOrders (code, comments excluded)');
assert(/website:\s*\{\s*fields:\s*WEBSITE_PUBLIC_FIELDS/.test(gmoCode),
  'populate uses `website: { fields: WEBSITE_PUBLIC_FIELDS }`');

out('\n=== 5) Snapshot publisher fields stripped for non-publisher viewers ===');
assert(
  /ORDER_SNAPSHOT_PUBLISHER_PRIVATE/.test(ctrl),
  'ORDER_SNAPSHOT_PUBLISHER_PRIVATE constant defined'
);
const snapMatch = ctrl.match(/const\s+ORDER_SNAPSHOT_PUBLISHER_PRIVATE\s*=\s*\[([\s\S]*?)\];/);
const snapBody = snapMatch ? snapMatch[1] : '';
for (const k of ['websitePublisherEmail', 'websitePublisherName', 'websitePublisherPrice']) {
  assert(snapBody.includes(`'${k}'`), `'${k}' listed in snapshot-private set`);
}
assert(
  /function\s+isCallerPublisherOfOrder\s*\(/.test(ctrl),
  'isCallerPublisherOfOrder helper defined'
);
assert(
  /for\s*\(\s*const\s+order\s+of\s+orders\s*\)[\s\S]{0,400}!isCallerPublisherOfOrder\(\s*order\s*,\s*user\s*\)[\s\S]{0,200}delete\s+order\[/.test(gmoBody),
  'getMyOrders post-fetch loop strips snapshot fields when caller !== publisher'
);

out('\n=== 6) gsc_refresh_token can NEVER appear in the API response ===');
// (a) Not in the allow-list (already asserted in §3)
// (b) The snapshot constants don't include it either
assert(!snapBody.includes('gsc_refresh_token'),
  'gsc_refresh_token NOT in snapshot private set (already absent from allow-list — would never be populated)');
// (c) Defense check: no other place in this handler explicitly populates
// it as code (comments may reference it for forensic purposes).
assert(!/gsc_refresh_token/.test(gmoCode),
  'gsc_refresh_token not referenced as code anywhere in getMyOrders');

out('\n=== 7) Filter functionality (status, type, pagination, sort) preserved ===');
assert(/status\s*&&\s*status\.trim\(\)/.test(gmoBody), 'status filter still parsed from query');
assert(/statuses\.length\s*>\s*1[\s\S]{0,120}orderStatus\s*=\s*\{\s*\$in/.test(gmoBody),
  'multiple statuses build the $in clause');
assert(/baseFilters\.advertiser\s*=\s*user\.id/.test(gmoBody),
  'type=advertiser still scopes to user.id');
assert(/baseFilters\.\$or\s*=\s*\[[\s\S]{0,200}publisher:\s*user\.id/.test(gmoBody),
  'type=publisher still scopes via publisher relation OR snapshot email');
assert(/Math\.min\(50/.test(gmoBody), 'pageSize still capped at 50 server-side');
assert(/validSortFields/.test(gmoBody) && /validSortOrders/.test(gmoBody),
  'sort field + order whitelists still enforced');

out('\n=== 8) Cart controller no longer exposes publisher_writing_price ===');
assert(cart.length > 0, 'cart.js readable');
// The hand-shaped item-website block (l.36+) used to include
// `publisher_writing_price: marketplace.publisher_writing_price`. Forbid that.
assert(
  !/publisher_writing_price:\s*marketplace\.publisher_writing_price/.test(cart),
  'cart.js no longer copies marketplace.publisher_writing_price into the response'
);
assert(
  /publisher_writing_price intentionally NOT exposed/.test(cart),
  'cart.js documents why publisher_writing_price was removed (anti-regression marker)'
);

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
