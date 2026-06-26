#!/usr/bin/env node
/**
 * Regression test for audit C3 — `POST /api/transactions/verify-paypal` is now
 * server-authoritative.
 *
 * Pre-fix exploit: handler accepted `{orderId, walletId}` from the request
 * body, called `getPayPalOrderDetails(orderId)`, and credited the
 * client-supplied `walletId` by PayPal's gross amount. The idempotency check
 * was keyed on `(orderId, walletId)` — re-binding the same PayPal order to
 * a different wallet was permitted. Net effect: any authenticated user who
 * knew any completed PayPal orderId could credit their own wallet with
 * someone else's PayPal payment. Plus there was no M11 amount-mismatch
 * cross-check, re-opening the baseAmount-tampering vector here.
 *
 * Post-fix: handler ignores `body.walletId`. It parses `walletId`,
 * `baseAmount`, `expectedChargeCents` from the PayPal order's `custom_id`
 * (server-set at createPayment time), then:
 *   1. Enforces `wallet.users_permissions_user.id === ctx.state.user.id`
 *      — caller must own the wallet the order is bound to.
 *   2. Idempotency keyed on `gatewayTransactionId = orderId` across ALL
 *      wallets — same PayPal order cannot be re-credited elsewhere.
 *   3. M11 cross-check: `actualChargeCents === expectedChargeCents`,
 *      else writes a failed-tx audit row and refuses to credit.
 *   4. Credits wallet by server-derived `baseAmount`, not by PayPal gross.
 *
 * Static-grep test only — no Strapi load.
 *
 * Run: cd serpbays_server && node scripts/test-verify-paypal-server-authoritative.js
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

const CTRL = 'src/api/transaction/controllers/transaction.js';
const src = read(CTRL);

// Slice out the verifyPayPalPayment method body.
const startIdx = src.indexOf('async verifyPayPalPayment(ctx)');
assert(startIdx > 0, 'verifyPayPalPayment method exists');
// Take the next 8000 chars — enough to capture the whole method.
const block = src.slice(startIdx, startIdx + 8000);
// Trim to the first `\n  },\n` after a real closing — good enough for greps.
const bodyEnd = block.indexOf('\n  },\n');
const body = bodyEnd > 0 ? block.slice(0, bodyEnd) : block;

out('\n=== 1) Body destructure no longer extracts client-supplied walletId ===');
// The vulnerable shape: `const { orderId, walletId } = ctx.request.body`.
// Now the only body field used is orderId.
assert(
  !/const\s*\{\s*[^}]*walletId[^}]*\}\s*=\s*ctx\.request\.body/.test(body),
  'no `walletId` destructured from ctx.request.body'
);
assert(
  /const\s*\{\s*orderId\s*\}\s*=\s*ctx\.request\.body/.test(body),
  'orderId is the only body field destructured'
);

out('\n=== 2) Caller identity is enforced (ctx.state.user.id) ===');
assert(
  /ctx\.state\.user\??\.id/.test(body),
  'reads ctx.state.user.id'
);
assert(
  /if\s*\(\s*!userId\s*\)\s*return\s+ctx\.unauthorized/.test(body),
  'fails closed when no authenticated user'
);

out('\n=== 3) custom_id is parsed for the authoritative wallet binding ===');
assert(/custom_id/.test(body), 'reads purchase_units[0].custom_id');
assert(
  /customData\.walletId/.test(body) || /customWalletId/.test(body),
  'extracts walletId from custom_id (server-set)'
);
assert(
  /customData\.expectedChargeCents/.test(body) || /expectedChargeCents/.test(body),
  'extracts expectedChargeCents from custom_id'
);
assert(
  /customData\.baseAmount/.test(body) || /\bbaseAmount\b/.test(body),
  'extracts baseAmount from custom_id'
);

out('\n=== 4) Ownership check blocks cross-user replay ===');
assert(
  /wallet\.users_permissions_user\??\.id\s*!==\s*userId/.test(body),
  'compares wallet owner to caller and rejects mismatch'
);
assert(
  /ctx\.forbidden\s*\(/.test(body),
  'returns 403 forbidden on ownership mismatch'
);

out('\n=== 5) Idempotency is keyed on gatewayTransactionId across all wallets ===');
// The vulnerable shape filtered by both gatewayTransactionId AND user_wallet,
// so re-binding to a different wallet was permitted. Forbid that exact filter
// pair and require an orderId-only success lookup.
assert(
  !/where:\s*\{\s*gatewayTransactionId:\s*orderId\s*,\s*user_wallet/.test(body),
  'no (gatewayTransactionId, user_wallet) tuple filter for idempotency'
);
assert(
  /gatewayTransactionId:\s*orderId[\s\S]*transactionStatus:\s*['"]success['"]/.test(body),
  'idempotency lookup includes transactionStatus: "success"'
);

out('\n=== 6) M11 amount-mismatch cross-check is in place ===');
assert(
  /actualChargeCents/.test(body) && /expectedChargeCents/.test(body),
  'computes actualChargeCents and compares to expectedChargeCents'
);
assert(
  /actualChargeCents\s*!==\s*expectedChargeCents/.test(body),
  'explicit mismatch comparison'
);
assert(
  /transactionStatus:\s*['"]failed['"]/.test(body),
  'failed-tx audit record created on mismatch'
);
assert(
  /GRACE_PERIOD_END/.test(body) && /2026-07-16/.test(body),
  'grace-period window matches M11 (until 2026-07-16)'
);

out('\n=== 7) Wallet credit uses server-derived baseAmount, not PayPal gross ===');
assert(
  /amountToCredit\s*=\s*baseAmount[^P]+paypalChargeAmount/.test(body),
  'amountToCredit prefers baseAmount, falls back to paypalChargeAmount only in legacy branch'
);

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
