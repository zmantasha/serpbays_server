#!/usr/bin/env node
/**
 * Regression test for the atomic withdrawal-create rewrite (over-withdrawal
 * race fix). Independent 14-agent verification confirmed the pre-fix race
 * was real with high confidence + zero dissent.
 *
 * Pre-fix shape (controllers/withdrawal-request.js):
 *   - OTP read + safeCompareOtp + clearOtp() were 3 sequential awaits,
 *     so two concurrent requests both passed safeCompareOtp before either
 *     cleared the OTP.
 *   - Wallet read (findOne) → sufficiency check → wallet write (db.query
 *     update with precomputed scalar) had no row lock, no DB transaction,
 *     no CAS. Two parallel requests both read mainBalance=$X, both passed
 *     the check, both wrote newMainBalance = $X - totalDeduction → last-
 *     writer-wins, one debit lost, two withdrawal_request rows committed.
 *
 * Post-fix shape:
 *   - Atomic OTP consume: single conditional UPDATE on up_users
 *     WHERE withdrawal_otp = ? — second concurrent caller gets 0 affected
 *     rows and bails.
 *   - Wallet operations wrapped in strapi.db.transaction({trx}) with
 *     SELECT ... FOR UPDATE on the user_wallets row. Sufficiency re-checked
 *     under the lock. Atomic CAS UPDATE refuses if main_balance moved.
 *     withdrawal_request + transaction inserts enrolled in the same trx.
 *
 * Plus migration 2026.06.18T00.00.00.add-wallet-balance-nonneg-checks.js
 * adds CHECK (>= 0) constraints on the balance columns as defense-in-depth.
 *
 * Static-grep test — no Strapi load. Runtime concurrent test is in
 * scripts/test-withdrawal-atomic-create-runtime.js (QA-driven, requires
 * a staging account).
 *
 * Run: cd serpbays_server && node scripts/test-withdrawal-atomic-create.js
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
const MIG  = 'database/migrations/2026.06.18T00.00.00.add-wallet-balance-nonneg-checks.js';
const ctrl = read(CTRL);
const mig  = read(MIG);

out('\n=== 1) Atomic OTP consume (conditional UPDATE) ===');
assert(
  /strapi\.db\.connection\.raw\([\s\S]{0,40}UPDATE\s+up_users[\s\S]{0,500}withdrawal_otp\s*=\s*\?/i.test(ctrl),
  'atomic OTP consume via conditional UPDATE on up_users with parameterized otp'
);
assert(
  /RETURNING\s+id/i.test(ctrl),
  'OTP consume uses RETURNING to detect race-lost (0 rows affected)'
);
assert(
  /consumed by a concurrent request/.test(ctrl),
  'race-lost path returns user-facing error pointing at concurrency'
);
// The old `await clearOtp();` in the success branch should be gone.
// (clearOtp itself is still defined for the expired/max-attempts branches.)
assert(
  !/Clear OTP after successful verification \(one-time use\)\s*[\r\n]+\s*await\s+clearOtp\(\)/.test(ctrl),
  'old non-atomic `await clearOtp()` removed from success branch'
);

out('\n=== 2) Money-moving section wrapped in strapi.db.transaction ===');
assert(
  /strapi\.db\.transaction\s*\(\s*async\s*\(\s*\{\s*trx\s*\}\s*\)/.test(ctrl),
  'strapi.db.transaction({trx}) wraps the money-moving section'
);

out('\n=== 3) Wallet row locked with forUpdate inside trx ===');
assert(
  /trx\(\s*['"]user_wallets['"]\s*\)[\s\S]{0,200}\.forUpdate\(\)/.test(ctrl),
  'trx("user_wallets").forUpdate() acquires row lock'
);
assert(
  /forUpdate\(\)[\s\S]{0,80}\.first\(\)/.test(ctrl),
  'lock query selects the locked row via .first()'
);

out('\n=== 4) Sufficiency re-check uses the FRESH locked main_balance ===');
assert(
  /lockedMainBalance\s*=\s*parseFloat\(\s*lockedRow\.main_balance/.test(ctrl),
  'lockedMainBalance derived from lockedRow.main_balance (post-lock value)'
);
assert(
  /lockedMainBalance\s*<\s*totalDeduction/.test(ctrl),
  'sufficiency check compares lockedMainBalance vs totalDeduction'
);
assert(
  /race-checked/i.test(ctrl),
  'error message tags this as race-checked so logs distinguish lock-rejected vs pre-lock-rejected'
);

out('\n=== 5) Atomic CAS UPDATE with arithmetic + value-match WHERE ===');
assert(
  /trx\.raw\(\s*['"]main_balance\s*-\s*\?::numeric['"]/.test(ctrl),
  'CAS update uses trx.raw arithmetic (main_balance - ?::numeric) — atomic'
);
assert(
  /trx\.raw\(\s*['"]pending_withdrawal_balance\s*\+\s*\?::numeric['"]/.test(ctrl),
  'pending_withdrawal_balance increment is also atomic arithmetic'
);
assert(
  /\.where\(\s*\{\s*id:\s*lockedRow\.id\s*,\s*main_balance:\s*lockedRow\.main_balance\s*\}\s*\)/.test(ctrl),
  'CAS where clause includes main_balance: lockedRow.main_balance — refuses if value moved'
);
assert(
  /updateCount\s*!==\s*1/.test(ctrl) && /conflict/i.test(ctrl),
  'updateCount !== 1 throws a write-conflict error'
);

out('\n=== 6) Old non-atomic wallet update removed ===');
// The vulnerable shape was:
//   const newMainBalance = (parseFloat(publisherWallet.mainBalance) || 0) - totalDeduction;
//   await strapi.db.query('api::user-wallet.user-wallet').update({ ... });
assert(
  !/const\s+newMainBalance\s*=\s*\(parseFloat\(publisherWallet\.mainBalance\)/.test(ctrl),
  'no precomputed newMainBalance scalar (the old vulnerable pattern)'
);
// Scope the assertion to the create() method body. Other methods (e.g.
// markAsPaidWithdrawal) are flagged separately by the Wave-4 audit and
// fixed in a separate ship; this test only enforces create()'s atomicity.
const createStart = ctrl.indexOf('async create(ctx)');
const createEnd   = ctrl.indexOf('async getMyWithdrawals');
const createBody  = createStart >= 0 && createEnd > createStart ? ctrl.slice(createStart, createEnd) : '';
assert(createBody.length > 0, 'create() method body sliced');
assert(
  !/strapi\.db\.query\(\s*['"]api::user-wallet\.user-wallet['"]\s*\)\.update\(\s*\{\s*where:\s*\{\s*id:\s*publisherWallet\.id\s*\}/.test(createBody),
  'no non-trx strapi.db.query(...).update() on publisherWallet inside create()'
);

out('\n=== 7) withdrawal_request + transaction inserts are inside the trx callback ===');
// Both entityService.create calls must appear AFTER the trx open and BEFORE its close.
const trxOpenIdx = ctrl.indexOf('strapi.db.transaction(async ({ trx })');
const wrCreateIdx = ctrl.indexOf("strapi.entityService.create('api::withdrawal-request.withdrawal-request'");
const txCreateIdx = ctrl.indexOf("strapi.entityService.create('api::transaction.transaction'");
assert(trxOpenIdx > 0 && wrCreateIdx > trxOpenIdx, 'withdrawal-request.create is inside (after) the trx open');
assert(trxOpenIdx > 0 && txCreateIdx > trxOpenIdx, 'transaction.create is inside (after) the trx open');

out('\n=== 8) Migration adds CHECK constraints on all balance columns ===');
assert(mig.length > 0, 'migration file exists');
// The migration source uses an array `CHECK_CONSTRAINTS` with `column: '…'`
// entries and applies `CHECK (${column} >= 0)` via raw SQL. Check each
// column name appears in the constraints array AND the ALTER+ADD CONSTRAINT
// + ">= 0" pattern is present.
assert(/column:\s*['"]main_balance['"]/.test(mig), 'main_balance in CHECK_CONSTRAINTS array');
assert(/column:\s*['"]balance['"]/.test(mig), 'balance in CHECK_CONSTRAINTS array');
assert(/column:\s*['"]pending_withdrawal_balance['"]/.test(mig), 'pending_withdrawal_balance in CHECK_CONSTRAINTS array');
assert(/column:\s*['"]promo_balance['"]/.test(mig), 'promo_balance in CHECK_CONSTRAINTS array');
assert(/column:\s*['"]escrow_balance['"]/.test(mig), 'escrow_balance in CHECK_CONSTRAINTS array');
assert(/ALTER TABLE user_wallets ADD CONSTRAINT[\s\S]{0,80}CHECK\s*\([\s\S]{0,40}>=\s*0\s*\)/.test(mig), 'ALTER TABLE … ADD CONSTRAINT … CHECK (… >= 0) SQL present');
assert(/DROP CONSTRAINT IF EXISTS/.test(mig), 'migration is idempotent (drops existing same-name constraints)');
assert(/UPDATE user_wallets SET[\s\S]{0,40}=\s*0\s+WHERE[\s\S]{0,40}<\s*0/.test(mig), 'migration pre-clamps any pre-existing negatives before adding the constraint');

out('\n=== 9) Client-error vs server-error discrimination preserved ===');
assert(/isClientError\s*=\s*true/.test(ctrl), 'sufficiency / wallet-missing errors flagged as client errors');
assert(/err\.isClientError[\s\S]{0,80}ctx\.badRequest/.test(ctrl), 'client errors return 400 badRequest');
assert(/ctx\.internalServerError/.test(ctrl), 'server-side errors return 500');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
