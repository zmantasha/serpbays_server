#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 10: marketplace-list + user-wallet remainder.
 *
 * Findings closed:
 *   - HIGH: marketplace-list.find / findOne / update populated `marketplaces`
 *     as `populate: { marketplaces: true }` (all columns). Strapi's
 *     sanitizeOutput only strips schema-declared private attributes; the
 *     marketplace schema only marks `publisher_name / publisher_email /
 *     gsc_refresh_token` private. So every list response leaked
 *     publisher_*_pricing (intake prices), gsc_permission_level,
 *     approvalStatus / blacklist_status / delistedReason / dataVersion,
 *     bulkRefreshSkipTools, and the six last*Refresh/Export timestamps
 *     for every marketplace included in a saved list. Frontend only uses
 *     `marketplaces.length` and `marketplaces.map(m => m.id)`. Narrowed
 *     to `{ select: ['id'] }`.
 *   - LOW: marketplace-list.update echoed `error.message` in the
 *     internalServerError response. Stripped; server-side log only.
 *   - LOW: marketplace-list.findOne id was not integer-validated before
 *     the DB query. Now validated.
 *   - MEDIUM (DoS): user-wallet.getTransactions accepted unbounded
 *     pageSize from query. Could request pageSize=10_000_000 to attempt
 *     memory exhaustion via huge JSON. Capped at 100; page validated.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass10.js
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

const ML = read('src/api/marketplace-list/controllers/marketplace-list.js');
const UW = read('src/api/user-wallet/controllers/user-wallet.js');

out('\n=== 1) marketplace-list — populate narrowed to {id} ===');
// Strip comments so explanatory text doesn't false-positive.
const mlCode = ML.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
// `populate: { marketplaces: true }` must NOT remain as CODE.
assert(!/populate:\s*\{\s*marketplaces:\s*true\s*\}/.test(mlCode),
  'no remaining populate: { marketplaces: true } (all-columns populate gone)');
const narrowMatches = (mlCode.match(/marketplaces:\s*\{\s*select:\s*\['id'\]\s*\}/g) || []).length;
assert(narrowMatches >= 3,
  `marketplaces populated with { select: ['id'] } in all three handlers (find/findOne/update reload) — found ${narrowMatches}`);

out('\n=== 2) marketplace-list — ownership/auth preserved across handlers ===');
// Spot-check that each handler keeps the user.id-based ownership filter.
for (const h of ['find', 'findOne', 'update', 'delete']) {
  const idx = ML.indexOf(`async ${h}(ctx)`);
  // Slice forward to the closing of the method (next async or end of file)
  const after = ML.slice(idx, idx + 2000);
  assert(/if\s*\(\s*!user\s*\)[\s\S]{0,80}ctx\.unauthorized/.test(after),
    `${h}: requires authenticated user`);
  // Ownership: ` owner: user.id ` appears in the WHERE clause
  assert(/owner:\s*user\.id/.test(after),
    `${h}: scopes by owner: user.id`);
}

out('\n=== 3) marketplace-list — error.message not echoed in update ===');
const updateStart = ML.indexOf('async update(ctx)');
const updateEnd   = ML.indexOf('async delete(ctx)');
const updateBody  = updateStart > 0 && updateEnd > updateStart ? ML.slice(updateStart, updateEnd) : '';
const updateCode  = updateBody.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/internalServerError\([^)]*error\.message|internalServerError\(\s*['"][^'"]*\s*\+\s*error\.message/.test(updateCode),
  'update no longer concatenates error.message into the HTTP response');
assert(/strapi\.log\??\.error/.test(updateCode),
  'update logs error server-side via strapi.log.error');

out('\n=== 4) marketplace-list.findOne — id validated as positive integer ===');
const findOneStart = ML.indexOf('async findOne(ctx)');
const findOneEnd   = ML.indexOf('async update(ctx)');
const findOneBody  = findOneStart > 0 && findOneEnd > findOneStart ? ML.slice(findOneStart, findOneEnd) : '';
assert(/Number\.isInteger\s*\(\s*numericId\s*\)\s*\|\|\s*numericId\s*<=\s*0/.test(findOneBody),
  'findOne validates id as positive integer');

out('\n=== 5) user-wallet.getTransactions — pageSize hard-capped ===');
const gtStart = UW.indexOf('async getTransactions(ctx)');
const gtEnd   = UW.indexOf('async createWallet(ctx)');
const gt      = gtStart > 0 && gtEnd > gtStart ? UW.slice(gtStart, gtEnd) : '';
assert(/Math\.min\s*\(\s*rawPageSize\s*,\s*100\s*\)/.test(gt),
  'pageSize hard-capped at 100');
assert(/Number\.isFinite\s*\(\s*rawPage\s*\)/.test(gt),
  'page validated as finite number');
assert(/rawPage\s*>=\s*1/.test(gt),
  'page enforced >= 1');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
