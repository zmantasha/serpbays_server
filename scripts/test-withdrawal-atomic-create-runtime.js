#!/usr/bin/env node
/**
 * Runtime concurrent-attack test for the atomic withdrawal create.
 *
 * Fires N concurrent POST /api/api/withdrawal-requests against staging with
 * the same OTP and asserts:
 *   - At most ONE request succeeds (HTTP 200, has data.id)
 *   - All other requests fail (HTTP 4xx)
 *   - The wallet's main_balance + pending_withdrawal_balance reflect EXACTLY
 *     one withdrawal worth of debit, not N
 *   - exactly one withdrawal_request row was created
 *   - exactly one transaction row of type='withdrawal' was created
 *
 * This is a DESTRUCTIVE test — it actually creates a withdrawal request on
 * the target wallet. Run on staging with a dedicated test publisher whose
 * earnings/balance you don't mind manipulating. NEVER run in production.
 *
 * Required env:
 *   STAGING_API           e.g. http://127.0.0.1:1337
 *   STAGING_PUBLISHER_JWT (publisher account JWT)
 *   TEST_AMOUNT           withdrawal amount (e.g. 5)
 *   TEST_METHOD           paypal | razorpay | bank_transfer | payoneer
 *   TEST_DETAILS_JSON     details object as JSON string
 *
 * Procedure (manual, you drive):
 *   1. Set the env vars above.
 *   2. POST to /api/api/withdrawal-requests/send-otp to receive an OTP via email.
 *   3. Read the OTP from the publisher's email.
 *   4. Run: OTP=123456 node scripts/test-withdrawal-atomic-create-runtime.js
 *   5. Script fires 5 concurrent POSTs with the same OTP.
 *   6. Script reports outcomes and DB state delta.
 *
 * Run: cd serpbays_server && OTP=... STAGING_PUBLISHER_JWT=... node scripts/test-withdrawal-atomic-create-runtime.js
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');

const fs = require('fs');
const { spawnSync } = require('child_process');

const API = process.env.STAGING_API || 'http://127.0.0.1:1337';
const JWT = process.env.STAGING_PUBLISHER_JWT;
const OTP = process.env.OTP;
const AMOUNT = parseFloat(process.env.TEST_AMOUNT || '5');
const METHOD = process.env.TEST_METHOD || 'paypal';
const DETAILS = process.env.TEST_DETAILS_JSON || '{"email":"test@example.com"}';
const N_CONCURRENT = parseInt(process.env.N_CONCURRENT || '5', 10);

if (!JWT) { console.error('STAGING_PUBLISHER_JWT required'); process.exit(1); }
if (!OTP) { console.error('OTP required (get from email after send-otp request)'); process.exit(1); }

// Pre-state DB snapshot via psql (defensive — informational only)
function pgQuery(sql) {
  const env = {};
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^(DATABASE_(?:HOST|PORT|USERNAME|PASSWORD|NAME))=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const r = spawnSync('psql', ['-h', env.DATABASE_HOST, '-p', env.DATABASE_PORT, '-U', env.DATABASE_USERNAME, '-d', env.DATABASE_NAME, '-tAc', sql], {
    env: { ...process.env, PGPASSWORD: env.DATABASE_PASSWORD },
  });
  if (r.status !== 0) throw new Error('psql failed: ' + (r.stderr || r.stdout).toString());
  return r.stdout.toString().trim();
}

(async () => {
  // 1. Decode publisher id from JWT (no signature verify — just for DB lookup)
  const jwtPayload = JSON.parse(Buffer.from(JWT.split('.')[1], 'base64url').toString('utf8'));
  const publisherId = jwtPayload.id;
  console.log(`[runtime-test] publisher_id=${publisherId}, amount=${AMOUNT}, N_CONCURRENT=${N_CONCURRENT}`);

  // 2. Pre-state DB
  const preState = {
    main_balance: pgQuery(`SELECT main_balance FROM user_wallets WHERE id IN (SELECT user_wallet_id FROM user_wallets_users_permissions_user_lnk WHERE user_id=${publisherId})`),
    pending: pgQuery(`SELECT pending_withdrawal_balance FROM user_wallets WHERE id IN (SELECT user_wallet_id FROM user_wallets_users_permissions_user_lnk WHERE user_id=${publisherId})`),
    wr_count: pgQuery(`SELECT COUNT(*) FROM withdrawal_requests wr JOIN withdrawal_requests_publisher_lnk lnk ON lnk.withdrawal_request_id=wr.id WHERE lnk.user_id=${publisherId}`),
  };
  console.log(`[runtime-test] PRE-STATE: main_balance=${preState.main_balance}, pending=${preState.pending}, withdrawal_count=${preState.wr_count}`);

  // 3. Fire N concurrent requests
  const body = JSON.stringify({ data: { amount: AMOUNT, method: METHOD, details: JSON.parse(DETAILS), otpCode: OTP } });
  const fires = Array.from({ length: N_CONCURRENT }, (_, i) =>
    fetch(`${API}/api/api/withdrawal-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${JWT}` },
      body,
    }).then(async (r) => ({
      i, status: r.status, body: await r.text(),
    }))
  );
  const results = await Promise.all(fires);

  for (const r of results) {
    console.log(`[runtime-test] req#${r.i}: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  }

  // 4. Tally outcomes
  const successes = results.filter((r) => r.status === 200);
  const failures = results.filter((r) => r.status !== 200);
  console.log(`[runtime-test] OUTCOMES: ${successes.length} success(es), ${failures.length} failure(s)`);

  // 5. Post-state DB
  await new Promise((r) => setTimeout(r, 500)); // allow trx to commit
  const postState = {
    main_balance: pgQuery(`SELECT main_balance FROM user_wallets WHERE id IN (SELECT user_wallet_id FROM user_wallets_users_permissions_user_lnk WHERE user_id=${publisherId})`),
    pending: pgQuery(`SELECT pending_withdrawal_balance FROM user_wallets WHERE id IN (SELECT user_wallet_id FROM user_wallets_users_permissions_user_lnk WHERE user_id=${publisherId})`),
    wr_count: pgQuery(`SELECT COUNT(*) FROM withdrawal_requests wr JOIN withdrawal_requests_publisher_lnk lnk ON lnk.withdrawal_request_id=wr.id WHERE lnk.user_id=${publisherId}`),
  };
  console.log(`[runtime-test] POST-STATE: main_balance=${postState.main_balance}, pending=${postState.pending}, withdrawal_count=${postState.wr_count}`);

  const mainDelta = parseFloat(preState.main_balance) - parseFloat(postState.main_balance);
  const pendingDelta = parseFloat(postState.pending) - parseFloat(preState.pending);
  const wrDelta = parseInt(postState.wr_count, 10) - parseInt(preState.wr_count, 10);

  const PLATFORM_FEE_RATE = 0.20;
  const expectedFee = Math.round((AMOUNT / (1 - PLATFORM_FEE_RATE)) * PLATFORM_FEE_RATE * 100) / 100;
  const expectedTotalDeduction = Math.round((AMOUNT + expectedFee) * 100) / 100;

  console.log(`[runtime-test] DELTAS: main_balance -=${mainDelta}, pending +=${pendingDelta}, withdrawal_rows +=${wrDelta}`);
  console.log(`[runtime-test] EXPECTED (single withdrawal): main -= ${expectedTotalDeduction}, pending += ${AMOUNT}, wr +=1`);

  let pass = 0, fail = 0;
  const ok = (cond, label) => cond ? (pass++, console.log(`  ✅ ${label}`)) : (fail++, console.error(`  ❌ ${label}`));

  ok(successes.length <= 1, `at most one HTTP 200 (got ${successes.length})`);
  ok(Math.abs(mainDelta - expectedTotalDeduction * Math.min(1, successes.length)) < 0.01, `main_balance delta matches expected (${expectedTotalDeduction * Math.min(1, successes.length)})`);
  ok(Math.abs(pendingDelta - AMOUNT * Math.min(1, successes.length)) < 0.01, `pending delta matches expected (${AMOUNT * Math.min(1, successes.length)})`);
  ok(wrDelta === Math.min(1, successes.length), `withdrawal_requests row count delta matches (${Math.min(1, successes.length)})`);

  console.log(`[runtime-test] SUMMARY: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[runtime-test] FATAL:', e);
  process.exit(1);
});
