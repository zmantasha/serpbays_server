#!/usr/bin/env node
/**
 * Regression test for the CMS status-transition accounting bug.
 *
 * Pre-fix: afterUpdate fired the destination handler on every update where the
 * new status matched, regardless of previous status. CMS / default update
 * route bypassed the controller's status guards, so an admin could flip
 *   denied → approved   (handleApprovedWithdrawal: only updates tx; wallet
 *                        stays over-credited from the prior deny)
 *   approved → denied   (handleDeniedWithdrawal re-fires: another gross refund
 *                        + another pendingWithdrawalBalance decrement)
 * compounding wallet over-credit and corrupting the pending-withdrawals
 * total (other publishers' pending holds appear to vanish as pending clamps
 * toward zero).
 *
 * Post-fix:
 *   - beforeUpdate reads the row(s)' current status, validates against
 *     LEGAL_TRANSITIONS whitelist, throws ValidationError on illegal flips.
 *   - afterUpdate dispatches handlers ONLY when status actually changed
 *     (event.state.statusChanged === true).
 *
 * Static-grep test — no Strapi load.
 *
 * Run: cd serpbays_server && node scripts/test-withdrawal-status-transitions.js
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

const LIFE = 'src/api/withdrawal-request/content-types/withdrawal-request/lifecycles.js';
const src = read(LIFE);

out('\n=== 1) module.exports surfaces both lifecycle hooks ===');
assert(/module\.exports\s*=\s*\{[\s\S]*async\s+beforeUpdate\s*\(/.test(src), 'beforeUpdate exported');
assert(/module\.exports\s*=\s*\{[\s\S]*async\s+afterUpdate\s*\(/.test(src), 'afterUpdate exported');

out('\n=== 2) LEGAL_TRANSITIONS whitelist present and complete ===');
assert(/LEGAL_TRANSITIONS\s*=\s*\{/.test(src), 'LEGAL_TRANSITIONS map defined');
assert(/pending:\s*\[\s*['"]approved['"]\s*,\s*['"]denied['"]\s*\]/.test(src), "pending → ['approved','denied'] in whitelist");
assert(/approved:\s*\[[\s\S]{0,40}['"]paid['"]/.test(src), 'approved → paid in whitelist');
assert(/denied:\s*\[\s*\]/.test(src), 'denied → [] terminal');
assert(/paid:\s*\[\s*\]/.test(src), 'paid → [] terminal');

out('\n=== 3) beforeUpdate reads current row + computes transition ===');
const beforeStart = src.indexOf('async beforeUpdate(event)');
const afterStart  = src.indexOf('async afterUpdate(event)');
const beforeBody  = beforeStart >= 0 && afterStart > beforeStart ? src.slice(beforeStart, afterStart) : '';
assert(beforeBody.length > 0, 'beforeUpdate body sliced');
assert(/strapi\.db\.query\([^)]*withdrawal-request[^)]*\)\.findMany/.test(beforeBody), 'beforeUpdate queries current row(s) for previous status');
assert(/previousStatus[\s\S]{0,150}LEGAL_TRANSITIONS\[previousStatus\]/.test(beforeBody), 'beforeUpdate compares previousStatus against LEGAL_TRANSITIONS');
assert(/event\.state\.statusChanged\s*=\s*true/.test(beforeBody), 'beforeUpdate sets event.state.statusChanged on real transition');

out('\n=== 4) beforeUpdate throws ValidationError on illegal transition ===');
assert(/err\.name\s*=\s*['"]ValidationError['"]/.test(beforeBody), "ValidationError name set so Strapi surfaces it in admin UI");
assert(/throw\s+err/.test(beforeBody), 'beforeUpdate throws on illegal transition');
assert(/Illegal withdrawal status transition/.test(beforeBody), 'descriptive error message present');

out('\n=== 5) afterUpdate gates dispatch on event.state.statusChanged ===');
const afterBody = afterStart >= 0 ? src.slice(afterStart) : '';
assert(afterBody.length > 0, 'afterUpdate body sliced');
assert(/if\s*\(\s*!state\s*\|\|\s*!state\.statusChanged\s*\)\s*\{[\s\S]{0,40}return/.test(afterBody),
  'afterUpdate early-returns when status did not actually change');

out('\n=== 6) afterUpdate still dispatches the 3 handlers on legitimate transitions ===');
assert(/handleApprovedWithdrawal\(result\)/.test(afterBody), 'handleApprovedWithdrawal still called');
assert(/handlePaidWithdrawal\(result\)/.test(afterBody), 'handlePaidWithdrawal still called');
assert(/handleDeniedWithdrawal\(result\)/.test(afterBody), 'handleDeniedWithdrawal still called');

out('\n=== 7) Handlers themselves are still defined (no regression of legitimate path) ===');
assert(/async\s+function\s+handleApprovedWithdrawal\s*\(/.test(src), 'handleApprovedWithdrawal still defined');
assert(/async\s+function\s+handlePaidWithdrawal\s*\(/.test(src), 'handlePaidWithdrawal still defined');
assert(/async\s+function\s+handleDeniedWithdrawal\s*\(/.test(src), 'handleDeniedWithdrawal still defined');

out('\n=== 8) Illegal-transition scenarios (smoke check the whitelist rejects them) ===');
// Parse out the LEGAL_TRANSITIONS object by extracting the relevant slice and eval'ing in a sandboxed Function.
// Easier: scan for the specific illegal pairs in case someone accidentally adds them.
const ILLEGAL_PAIRS = [
  ['denied', 'approved'],
  ['denied', 'paid'],
  ['denied', 'pending'],
  ['paid',   'approved'],
  ['paid',   'denied'],
  ['paid',   'pending'],
  ['approved', 'pending'],
  ['pending',  'paid'],   // must go through approved first
];
const ltBlock = (src.match(/LEGAL_TRANSITIONS\s*=\s*\{[\s\S]*?\};/) || [''])[0];
for (const [from, to] of ILLEGAL_PAIRS) {
  // crude: in the from's array entry, the "to" must NOT appear
  const fromLine = (ltBlock.match(new RegExp(`${from}:\\s*\\[[^\\]]*\\]`)) || [''])[0];
  assert(!new RegExp(`['"]${to}['"]`).test(fromLine), `illegal: ${from} → ${to} not in whitelist`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
