#!/usr/bin/env node
/**
 * Regression test — first broad-sweep pass.
 *
 * Covered in this pass:
 *   - HIGH: Anonymous IDOR via /api/api/transactions/status/:id (numeric id
 *     enumeration). Confirmed exploitable on staging at id=85.
 *   - HIGH: Order error-message echo in payload.
 *   - CRITICAL: order createCoreRouter exposed GET/PUT/DELETE /api/orders[/:id]
 *     to any authenticated user with no ownership check. Default core
 *     controllers run; Authenticated role has find/findOne/update/delete.
 *     Write IDOR is a direct wallet-manipulation primitive (set
 *     orderStatus='completed' → release escrow).
 *   - LOW: ai-content generate/generateMeta echoed error.message to client.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass1.js
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

const TX = read('src/api/transaction/controllers/transaction.js');
const ORDER = read('src/api/order/controllers/order.js');
const AI = read('src/api/ai-content/controllers/ai-content.js');

out('\n=== 1) transaction.getTransactionStatus — anonymous-IDOR fix ===');
const gtsStart = TX.indexOf('async getTransactionStatus(ctx)');
const gtsEnd   = TX.indexOf('async verifyPayPalPayment');
const gtsBody  = gtsStart > 0 && gtsEnd > gtsStart ? TX.slice(gtsStart, gtsEnd) : '';
assert(gtsBody.length > 0, 'getTransactionStatus body sliced');
assert(/\/\^\\d\+\$\//.test(gtsBody),
  'rejects purely-numeric ids (kills enumeration vector)');
assert(/id\.length\s*>\s*256/.test(gtsBody),
  'bounds id length (defense vs path-param smuggling)');
assert(/where:\s*\{\s*gatewayTransactionId:\s*id\s*\}/.test(gtsBody),
  'only looks up by gatewayTransactionId (no `where: { id }` fallback)');
assert(!/where:\s*\{\s*id\s*\}/.test(gtsBody),
  'no internal-id fallback lookup remains');
assert(!/amount:\s*transaction\.amount/.test(gtsBody),
  'response no longer leaks transaction.amount');
assert(!/invoice:\s*transaction\.invoice/.test(gtsBody),
  'response no longer leaks transaction.invoice details');
assert(!/type:\s*transaction\.type/.test(gtsBody),
  'response no longer leaks transaction.type');
assert(/\/\^pi_\[a-zA-Z0-9_\]\+\$\//.test(gtsBody),
  'Stripe fallback restricted to ids matching ^pi_*');
assert(/Pre-fix accepted EITHER|amount.*invoice|invoice.*PDF/i.test(TX),
  'forensic comment documenting the prior vulnerability is present in the file');

out('\n=== 2) order — find/findOne/update/delete overrides exist ===');
const orderModExportsStart = ORDER.indexOf('module.exports = createCoreController(\'api::order.order\'');
assert(orderModExportsStart > 0, 'order controller uses createCoreController');
const after = ORDER.slice(orderModExportsStart);
assert(/async\s+find\s*\(\s*ctx\s*\)/.test(after),
  'find() overridden');
assert(/async\s+findOne\s*\(\s*ctx\s*\)/.test(after),
  'findOne() overridden');
assert(/async\s+update\s*\(\s*ctx\s*\)[\s\S]{0,800}ctx\.forbidden/.test(after),
  'update() overridden to forbid default-route writes');
assert(/async\s+delete\s*\(\s*ctx\s*\)[\s\S]{0,200}ctx\.forbidden/.test(after),
  'delete() overridden to forbid deletion');

out('\n=== 3) order find/findOne — ownership + allow-list ===');
assert(/function\s+buildOrderOwnershipFilter\s*\(/.test(ORDER),
  'buildOrderOwnershipFilter helper defined');
assert(/\{\s*advertiser:\s*user\.id\s*\}/.test(ORDER) &&
       /\{\s*publisher:\s*user\.id\s*\}/.test(ORDER) &&
       /\{\s*websitePublisherEmail:\s*user\.email\s*\}/.test(ORDER),
  'ownership filter includes advertiser FK + publisher FK + snapshot email');
const findOverride = ORDER.match(/async\s+find\s*\(\s*ctx\s*\)\s*\{[\s\S]+?\n\s+\},\n\s+async\s+findOne/);
const findBody = findOverride ? findOverride[0] : '';
assert(/website:\s*\{\s*fields:\s*WEBSITE_PUBLIC_FIELDS\s*\}/.test(findBody),
  'find populates website with WEBSITE_PUBLIC_FIELDS allow-list');
assert(/advertiser:\s*\{\s*fields:\s*\['id',\s*'username'\]\s*\}/.test(findBody),
  'find populates advertiser with {id, username} allow-list');
assert(/publisher:\s*\{\s*fields:\s*\['id',\s*'username'\]\s*\}/.test(findBody),
  'find populates publisher with {id, username} allow-list');
assert(/userFilters\s*\?\s*\{\s*\$and:\s*\[\s*userFilters\s*,\s*ownership\s*\]/.test(findBody),
  'find merges caller filters under $and (cannot widen scope)');
assert(/ORDER_SNAPSHOT_PUBLISHER_PRIVATE/.test(findBody),
  'find strips snapshot publisher fields for non-publishers');
assert(/pageSize\s*>\s*100/.test(findBody) || /ps\s*>\s*100/.test(findBody),
  'find caps pageSize at 100');

const findOneMatch = ORDER.match(/async\s+findOne\s*\(\s*ctx\s*\)\s*\{[\s\S]+?\n\s+\},\n\s+async\s+update/);
const findOneBody = findOneMatch ? findOneMatch[0] : '';
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(findOneBody),
  'findOne validates id as positive integer');
assert(/isAdvertiser[\s\S]{0,300}isPublisherFK[\s\S]{0,300}isSnapshotPublisher/.test(findOneBody),
  'findOne checks advertiser / publisher FK / snapshot publisher');
assert(/if\s*\(\s*!isAdvertiser\s*&&\s*!isPublisherFK\s*&&\s*!isSnapshotPublisher\s*\)[\s\S]{0,200}ctx\.notFound/.test(findOneBody),
  'findOne returns 404 (not 403) on cross-tenant');

out('\n=== 4) order update/delete forbidden via default routes ===');
assert(/Direct order updates are not allowed/.test(ORDER),
  'update() error message references action endpoints');
assert(/Orders cannot be deleted/.test(ORDER),
  'delete() error message rejects deletion');

out('\n=== 5) ai-content — error.message no longer echoed ===');
assert(!/internalServerError\(error\.message/.test(AI),
  'ai-content does not pass error.message into HTTP error response');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
