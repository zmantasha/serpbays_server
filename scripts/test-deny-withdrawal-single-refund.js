#!/usr/bin/env node
/**
 * Regression test for audit Wave-4 R47 / R51 / R107 — withdrawal-deny
 * single-refund.
 *
 * Pre-fix exploit (observable on every legitimate deny, not an attack):
 *   1. Controller `denyWithdrawal` (controllers/withdrawal-request.js)
 *      sets withdrawal_status='denied' via entityService.update — this
 *      triggers the afterUpdate lifecycle.
 *   2. The same controller THEN inline-credits `withdrawalRequest.amount`
 *      (net only) to mainBalance and decrements pendingWithdrawalBalance
 *      AND creates a separate refund-tx row.
 *   3. The lifecycle `handleDeniedWithdrawal` ALSO fires and credits
 *      `totalRefund = amount + platformFee` (gross — matches what was
 *      originally debited at create-time).
 *   4. Net: wallet gets credited mainBalance += amount + (amount + fee)
 *      ≈ 1.8 × the intended refund on every legitimate deny.
 *
 * Fix: remove the inline refund block + redundant refund-tx creation in
 * the controller. The lifecycle is the source of truth (its math matches
 * what was debited at create).
 *
 * Static-grep test — no Strapi load.
 *
 * Run: cd serpbays_server && node scripts/test-deny-withdrawal-single-refund.js
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

const CTRL = 'src/api/withdrawal-request/controllers/withdrawal-request.js';
const LIFE = 'src/api/withdrawal-request/content-types/withdrawal-request/lifecycles.js';
const ctrl = read(CTRL);
const life = read(LIFE);

out('\n=== 1) Controller denyWithdrawal still exists + flips status to denied ===');
assert(/async\s+denyWithdrawal\s*\(/.test(ctrl), 'denyWithdrawal handler still defined');
const denyStart = ctrl.indexOf('async denyWithdrawal(ctx)');
const denyEnd = ctrl.indexOf('async markAsPaidWithdrawal');
const denyBody = denyStart >= 0 && denyEnd > denyStart ? ctrl.slice(denyStart, denyEnd) : '';
assert(denyBody.length > 0, 'denyWithdrawal body sliced');
assert(
  /withdrawal_status:\s*['"]denied['"]/.test(denyBody),
  'denyWithdrawal still sets withdrawal_status="denied" (so lifecycle fires)'
);

out('\n=== 2) Controller no longer does the inline refund credit ===');
// The vulnerable shape was: read mainBalance + refundAmount, write to user-wallet.
// Forbid both (a) the `mainBalance:` write key, and (b) the
// `pendingWithdrawalBalance: Math.max(0, ...)` write key, inside denyWithdrawal.
assert(
  !/mainBalance:\s*newMainBalance/.test(denyBody),
  'no `mainBalance: newMainBalance` write inside denyWithdrawal'
);
assert(
  !/pendingWithdrawalBalance:\s*Math\.max\s*\(\s*0/.test(denyBody),
  'no `pendingWithdrawalBalance: Math.max(0,...)` decrement inside denyWithdrawal'
);
assert(
  !/\bconst\s+refundAmount\s*=\s*parseFloat\(\s*withdrawalRequest\.amount\s*\)/.test(denyBody),
  'no refundAmount local computed inside denyWithdrawal'
);

out('\n=== 3) Controller no longer creates a separate refund-tx row ===');
// The redundant refund-tx creation had: type:'refund', transactionStatus:'denied',
// gateway:'internal', description containing 'Withdrawal request denied'.
// Forbid the type:'refund' + transactionStatus:'denied' pair inside denyWithdrawal.
assert(
  !/type:\s*['"]refund['"][\s\S]{0,400}transactionStatus:\s*['"]denied['"]/.test(denyBody),
  'no inline `type:"refund", transactionStatus:"denied"` create() in denyWithdrawal'
);

out('\n=== 4) Lifecycle handleDeniedWithdrawal is still present + still credits gross ===');
assert(
  /async\s+function\s+handleDeniedWithdrawal\s*\(/.test(life),
  'handleDeniedWithdrawal still defined in lifecycles.js'
);
assert(
  /totalRefund\s*=\s*Math\.round\s*\(\s*\(\s*withdrawalAmount\s*\+\s*platformFee\s*\)/.test(life),
  'lifecycle still computes totalRefund = withdrawalAmount + platformFee (gross)'
);
assert(
  /mainBalance:\s*newMainBalance/.test(life),
  'lifecycle still does the wallet credit'
);

out('\n=== 5) afterUpdate still routes "denied" to handleDeniedWithdrawal ===');
assert(
  /withdrawal_status\s*===\s*['"]denied['"][\s\S]{0,200}handleDeniedWithdrawal/.test(life),
  'afterUpdate dispatches denied → handleDeniedWithdrawal'
);

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
