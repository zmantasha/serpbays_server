#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 7: bank-transfer-request + reseller-code.
 *
 * Closes:
 *   - CRITICAL: bank-transfer-request.create trusted caller-supplied
 *     `userId` / `userEmail` / `userName`. A logged-in attacker could POST
 *     {amount:1000, userId:<victim_or_anyone>, referenceNumber:<known>, ...}
 *     to fabricate a bank-transfer claim under any user id. When admin
 *     later approved (matching the reference number against a real bank
 *     inflow, or via social engineering), the named userId's wallet was
 *     credited — a direct wallet-impersonation primitive. Now identity is
 *     derived from ctx.state.user; caller-supplied fields ignored.
 *   - HIGH: bank-transfer-request find/update used `auth.scope: ['admin']`
 *     which matches against permission ACTIONS, not role names. No such
 *     action exists, so the routes were functionally inaccessible to
 *     anyone — including admins. Now uses the real `global::is-admin` policy.
 *   - HIGH: bank-transfer-request.update wallet credit had no row lock +
 *     no sealed-state guard. Two concurrent PUTs to a 'pending' record
 *     both passed the read, both ran the credit block → wallet double-
 *     credited. Now wrapped in db.transaction + forUpdate + sealed
 *     completed/rejected states.
 *   - HIGH: reseller-code.useCode read-then-write race let two concurrent
 *     callers exceed `usageLimit` by N. Now atomic via trx + forUpdate.
 *   - MEDIUM: reseller-code.getCodeStats had NO ownership check — any
 *     authenticated user could read any code's full website-add list +
 *     usage stats. Now admin OR assignedTo only; 404 (not 403) on cross-
 *     tenant for enumeration defense.
 *   - MEDIUM: reseller-code.validateCode (PUBLIC endpoint) leaked
 *     assignedTo.username + usageLimit/usedCount/remainingUses to
 *     anonymous callers; populated full assignedTo user object. Response
 *     narrowed to {valid, message} for anonymous; service-internal callers
 *     use the service.validateCode for full data.
 *   - LOW: All three handlers no longer echo error.message; server-side
 *     log via strapi.log.error.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass7.js
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

const BTR_ROUTES = read('src/api/bank-transfer-request/routes/bank-transfer-request.js');
const BTR_CTRL   = read('src/api/bank-transfer-request/controllers/bank-transfer-request.js');
const RC_CTRL    = read('src/api/reseller-code/controllers/reseller-code.js');

out('\n=== 1) bank-transfer-request routes — broken scope replaced with policy ===');
// Comments may reference the prior pattern in explanation — match code only.
const btrRoutesCode = BTR_ROUTES.split('\n').map(l => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')).join('\n');
assert(!/scope:\s*\['admin'\]/.test(btrRoutesCode),
  'no remaining auth.scope: [admin] in code (was matched against permission actions, never role types)');
assert(/policies:\s*\['global::is-admin'\]/.test(BTR_ROUTES),
  'admin gate now uses global::is-admin policy');
const isAdminCount = (BTR_ROUTES.match(/global::is-admin/g) || []).length;
assert(isAdminCount >= 2, `global::is-admin applied to both find + update (found ${isAdminCount})`);

out('\n=== 2) bank-transfer-request.create — caller cannot impersonate ===');
const btrCreateStart = BTR_CTRL.indexOf('async create(ctx)');
const btrCreateEnd   = BTR_CTRL.indexOf('async find(ctx)');
const btrCreate      = btrCreateStart > 0 && btrCreateEnd > btrCreateStart ? BTR_CTRL.slice(btrCreateStart, btrCreateEnd) : '';
assert(btrCreate.length > 0, 'create body sliced');
// Body destructure must NOT pull userId/userEmail/userName
assert(!/const\s*\{[^}]*userId[^}]*\}\s*=\s*ctx\.request\.body/.test(btrCreate),
  'request body destructure no longer includes userId');
assert(!/const\s*\{[^}]*userEmail[^}]*\}\s*=\s*ctx\.request\.body/.test(btrCreate),
  'request body destructure no longer includes userEmail');
// Identity must come from JWT
assert(/const\s+userId\s*=\s*user\.id/.test(btrCreate),
  'userId derived from ctx.state.user.id');
assert(/const\s+userEmail\s*=\s*user\.email/.test(btrCreate),
  'userEmail derived from ctx.state.user.email');
// Bounds check on amount
assert(/parsedAmount\s*>\s*1_?000_?000/.test(btrCreate),
  'amount capped at $1M (no-overflow defense)');

out('\n=== 3) bank-transfer-request.update — transactional + sealed-state ===');
const btrUpdateStart = BTR_CTRL.indexOf('async update(ctx)');
const btrUpdateEnd   = BTR_CTRL.length;
const btrUpdate      = btrUpdateStart > 0 ? BTR_CTRL.slice(btrUpdateStart, btrUpdateEnd) : '';
assert(/strapi\.db\.transaction\s*\(\s*async\s*\(\s*\{\s*trx\s*\}\s*\)/.test(btrUpdate),
  'update wrapped in strapi.db.transaction');
assert(/\.forUpdate\(\)/.test(btrUpdate),
  'update acquires row lock via .forUpdate()');
assert(/request\.status\s*===\s*'completed'\s*\|\|\s*request\.status\s*===\s*'rejected'/.test(btrUpdate),
  'completed/rejected sealed-state guard');
assert(/Cannot transition from \$\{request\.status\} to \$\{status\}/.test(btrUpdate),
  'rejects illegal transitions');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(btrUpdate),
  'id validated as positive integer');

out('\n=== 4) reseller-code.validateCode — anonymous response narrowed ===');
const vcStart = RC_CTRL.indexOf('async validateCode(ctx)');
const vcEnd   = RC_CTRL.indexOf('async useCode(ctx)');
const vc      = vcStart > 0 && vcEnd > vcStart ? RC_CTRL.slice(vcStart, vcEnd) : '';
// No populate of assignedTo in validateCode (pre-fix returned the user object)
assert(!/populate:\s*\['assignedTo'\]/.test(vc),
  'no populate: [assignedTo] string-array');
assert(!/codeData\.assignedTo\.username/.test(vc),
  'no assignedTo.username leak in anonymous response');
// Response uses ctx.send with {valid, message} only (no data: {...id, usageLimit, ...})
const vcSends = (vc.match(/ctx\.send\(\s*\{[^}]+\}/g) || []);
const hasDataSection = vcSends.some(s => /data:\s*\{/.test(s));
assert(!hasDataSection, 'no data: {...} section in anonymous response (was leaking usage stats)');
// Length validation
assert(/code\.length\s*===\s*0\s*\|\|\s*code\.length\s*>\s*64/.test(vc),
  'code length-validated (rejects pathological inputs)');

out('\n=== 5) reseller-code.useCode — atomic increment via trx + forUpdate ===');
const ucStart = RC_CTRL.indexOf('async useCode(ctx)');
const ucEnd   = RC_CTRL.indexOf('async getCodeStats(ctx)');
const uc      = ucStart > 0 && ucEnd > ucStart ? RC_CTRL.slice(ucStart, ucEnd) : '';
assert(/strapi\.db\.transaction\s*\(\s*async\s*\(\s*\{\s*trx\s*\}\s*\)/.test(uc),
  'useCode wrapped in strapi.db.transaction');
assert(/trx\('reseller_codes'\)[\s\S]{0,200}\.forUpdate\(\)/.test(uc),
  'useCode acquires row lock on reseller_codes via .forUpdate()');
// Limit + expiry checks happen AFTER lock (not before — that was the race)
assert(/forUpdate\(\)[\s\S]{0,500}usage_limit\s*!==\s*null\s*&&\s*row\.used_count\s*>=\s*row\.usage_limit/.test(uc),
  'usage-limit check reads usedCount FROM the locked row (no stale-snapshot race)');

out('\n=== 6) reseller-code.getCodeStats — ownership-gated ===');
const csStart = RC_CTRL.indexOf('async getCodeStats(ctx)');
const csEnd   = RC_CTRL.length;
const cs      = csStart > 0 ? RC_CTRL.slice(csStart, csEnd) : '';
assert(/if\s*\(\s*!user\s*\)\s*return\s+ctx\.unauthorized/.test(cs),
  'requires authenticated caller');
assert(/user\.role\.type\s*===\s*'admin'\s*\|\|\s*user\.role\.type\s*===\s*'super_admin'/.test(cs),
  'admin gate uses role.type (no magic-string backdoor)');
assert(/codeData\.assignedTo\s*&&\s*codeData\.assignedTo\.id\s*===\s*user\.id/.test(cs),
  'allows the assigned reseller too');
assert(/if\s*\(\s*!isAdmin\s*&&\s*!isAssignee\s*\)[\s\S]{0,200}ctx\.notFound/.test(cs),
  '404 (not 403) on cross-tenant — enumeration defense');
// assignedTo populated id-only (no full user leak)
assert(/populate:\s*\{\s*assignedTo:\s*\{\s*select:\s*\['id'\]\s*\}\s*\}/.test(cs),
  'populate narrowed to {select: [id]} (no up_users PII leak)');

out('\n=== 7) None of the three handlers echoes error.message ===');
for (const [name, body] of [['btr.create', btrCreate], ['btr.update', btrUpdate], ['rc.validateCode', vc], ['rc.useCode', uc], ['rc.getCodeStats', cs]]) {
  assert(!/badRequest\([^)]*error\.message|internalServerError\([^)]*error\.message/.test(body),
    `${name}: no error.message echoed in HTTP response`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
