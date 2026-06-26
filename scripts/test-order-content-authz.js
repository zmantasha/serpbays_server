#!/usr/bin/env node
/**
 * Regression test: order-content endpoints — authz + IDOR hardening.
 *
 * Audited endpoint: GET /api/orders/:orderId/content (custom.getOrderContent).
 *
 * Findings remediated by this commit:
 *   - H-1: GET /api/order-contents (default core `find`) was reachable by
 *     the Authenticated role without any ownership filter — would return
 *     every order-content row on the platform. Now overridden in
 *     order-content.js with a per-user $or filter (advertiser FK,
 *     publisher FK, OR snapshot websitePublisherEmail).
 *   - M-1: 404 vs 403 differential on /orders/:id/content let an attacker
 *     probe which order IDs exist. Collapsed to 404 in both branches.
 *   - M-2: Publishers whose orders pre-date the publisher FK backfill
 *     (snapshot email only) were silently denied. Now permitted via
 *     snapshot-email fallback.
 *   - L-1: Response now uses an explicit field allow-list; future schema
 *     additions are NOT auto-exposed.
 *
 * Static-grep test — no Strapi load.
 *
 * Run: cd serpbays_server && node scripts/test-order-content-authz.js
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

const CUSTOM = read('src/api/order-content/controllers/custom.js');
const CORE   = read('src/api/order-content/controllers/order-content.js');
const ROUTE  = read('src/api/order-content/routes/custom-routes.js');
const SCHEMA = read('src/api/order-content/content-types/order-content/schema.json');

out('\n=== 1) Custom route registered correctly ===');
assert(/path:\s*'\/orders\/:orderId\/content'/.test(ROUTE), 'route path is /orders/:orderId/content');
assert(/handler:\s*'custom\.getOrderContent'/.test(ROUTE), 'handler is custom.getOrderContent');

out('\n=== 2) getOrderContent: auth + ownership + 404-not-403 ===');
assert(/if\s*\(\s*!\s*ctx\.state\.user\s*\)\s*\{[\s\S]{0,80}ctx\.unauthorized/.test(CUSTOM),
  'rejects unauthenticated callers');
assert(/function\s+isPartyToOrder\s*\(/.test(CUSTOM),
  'isPartyToOrder helper defined');
assert(/order\.advertiser\s*&&\s*order\.advertiser\.id\s*===\s*user\.id/.test(CUSTOM),
  'advertiser FK check');
assert(/order\.publisher\s*&&\s*order\.publisher\.id\s*===\s*user\.id/.test(CUSTOM),
  'publisher FK check');
assert(/!order\.publisher\?\.id[\s\S]{0,200}order\.websitePublisherEmail\s*===\s*user\.email/.test(CUSTOM),
  'snapshot-email fallback ONLY when publisher FK is absent');
// 404-not-403 enumeration defense
assert(!/forbidden\(/.test(CUSTOM),
  'no ctx.forbidden() — cross-tenant requests get 404 to defeat enumeration');
assert(/!order\s*\|\|\s*!isPartyToOrder\(order,\s*ctx\.state\.user\)[\s\S]{0,80}ctx\.notFound/.test(CUSTOM),
  'merged 404 on (not-found OR not-party)');

out('\n=== 3) getOrderContent: explicit field allow-list (no auto-leak) ===');
assert(/const\s+ORDER_CONTENT_PUBLIC_FIELDS\s*=\s*\[/.test(CUSTOM),
  'ORDER_CONTENT_PUBLIC_FIELDS allow-list defined');
const allowListMatch = CUSTOM.match(/const\s+ORDER_CONTENT_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\];/);
const allowList = allowListMatch ? allowListMatch[1] : '';
for (const expected of ["'title'", "'content'", "'url'", "'metaDescription'", "'keywords'",
                        "'anchorText'", "'links'", "'minWordCount'"]) {
  assert(allowList.includes(expected), `${expected} in allow-list`);
}
assert(/strapi\.db\.query\([\s\S]{0,80}\.findOne\(\s*\{[\s\S]{0,200}select:\s*ORDER_CONTENT_PUBLIC_FIELDS/.test(CUSTOM),
  'findOne uses the allow-list via select');

out('\n=== 4) getOrderContent: limited populate on parent order ===');
// We only need the relation IDs (and the snapshot email scalar) for the
// ownership check. We must NOT populate advertiser/publisher full objects.
assert(/populate:\s*\{[\s\S]{0,150}advertiser:\s*\{\s*fields:\s*\['id'\]\s*\}/.test(CUSTOM),
  'advertiser populated with fields:[id] only');
assert(/populate:\s*\{[\s\S]{0,200}publisher:\s*\{\s*fields:\s*\['id'\]\s*\}/.test(CUSTOM),
  'publisher populated with fields:[id] only');
assert(/fields:\s*\[[^\]]*'websitePublisherEmail'/.test(CUSTOM),
  'order fetched with only id + websitePublisherEmail scalars');

out('\n=== 5) Defense-in-depth — orderId validated as positive integer ===');
assert(/Number\.isInteger\s*\(\s*numericOrderId\s*\)\s*\|\|\s*numericOrderId\s*<=\s*0/.test(CUSTOM),
  'rejects non-integer / <=0 orderId with 404 (no SQL error leak)');

out('\n=== 6) order-content.js: H-1 fix — default find/findOne overridden ===');
assert(/async\s+find\s*\(\s*ctx\s*\)\s*\{/.test(CORE),
  'find() is overridden (closes un-gated /api/order-contents list)');
assert(/async\s+findOne\s*\(\s*ctx\s*\)\s*\{/.test(CORE),
  'findOne() is overridden (defense in depth for /api/order-contents/:id)');
assert(/function\s+buildOwnershipFilter\s*\(/.test(CORE),
  'buildOwnershipFilter helper centralizes the $or shape');
// The filter MUST be $or of advertiser/publisher/snapshot — never just one
assert(/\{\s*order:\s*\{\s*advertiser:\s*user\.id\s*\}\s*\}/.test(CORE),
  'find filter includes { order: { advertiser: user.id } }');
assert(/\{\s*order:\s*\{\s*publisher:\s*user\.id\s*\}\s*\}/.test(CORE),
  'find filter includes { order: { publisher: user.id } }');
assert(/\{\s*order:\s*\{\s*websitePublisherEmail:\s*user\.email\s*\}\s*\}/.test(CORE),
  'find filter includes snapshot-email branch');

out('\n=== 7) find() merges user filters under $and (caller cannot widen scope) ===');
assert(/userFilters\s*\?\s*\{\s*\$and:\s*\[\s*userFilters\s*,\s*ownership\s*\]/.test(CORE),
  'caller-supplied filters wrapped under $and with ownership filter');
assert(/fields:\s*ORDER_CONTENT_PUBLIC_FIELDS/.test(CORE),
  'find() forces field allow-list on response');
assert(/populate:\s*undefined/.test(CORE),
  'find() strips caller-supplied populate (prevents relation expansion)');

out('\n=== 8) findOne(): ownership check + 404-not-403 ===');
assert(/order\?\.advertiser\?\.id\s*===\s*user\.id/.test(CORE),
  'findOne advertiser FK check');
assert(/order\?\.publisher\?\.id\s*===\s*user\.id/.test(CORE),
  'findOne publisher FK check');
assert(/!order\?\.publisher\?\.id[\s\S]{0,150}order\.websitePublisherEmail\s*===\s*user\.email/.test(CORE),
  'findOne snapshot-email fallback gated on no publisher FK');
// Defense: ALL non-owner branches → 404
const findOneSlice = (() => {
  const s = CORE.indexOf('async findOne');
  const e = CORE.indexOf('async create');
  return s >= 0 && e > s ? CORE.slice(s, e) : '';
})();
assert(findOneSlice.length > 0, 'findOne slice extracted');
assert(!/ctx\.forbidden\(/.test(findOneSlice),
  'findOne never returns 403 (only 404 — enumeration defense)');
assert(/if\s*\(\s*!isOwner\s*\)[\s\S]{0,300}ctx\.notFound/.test(findOneSlice),
  'findOne returns 404 when not owner');

out('\n=== 9) findOne(): response strips the order relation (only scalars returned) ===');
assert(/const\s+safe\s*=\s*\{\s*\}[\s\S]{0,200}for\s*\(\s*const\s+k\s+of\s+ORDER_CONTENT_PUBLIC_FIELDS\s*\)/.test(findOneSlice),
  'findOne builds response from allow-list keys only (drops order/advertiser/publisher relation)');

out('\n=== 10) Sensitive fields not present in the schema (sanity) ===');
// The audited endpoint shouldn't be returning admin notes / GSC / wallet
// fields anyway — confirm the schema simply doesn't have them.
const schemaText = SCHEMA;
for (const banned of [
  'gsc_refresh_token', 'gscRefreshToken', 'gsc_permission_level',
  'wallet', 'walletBalance', 'admin_notes', 'adminNotes',
  'internal_notes', 'internalNotes', 'publisher_email',
]) {
  assert(!new RegExp(`"${banned}"`).test(schemaText),
    `schema has no "${banned}" attribute (would be a new leak vector if added)`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
