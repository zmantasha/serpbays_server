#!/usr/bin/env node
/**
 * Regression test for audit C9 — generic `POST /api/transactions/webhook/:gateway`
 * (plus its typo-duplicate `/api/api/transactions/webhook/:gateway`) and the
 * `transaction.handleWebhook` controller method removed.
 *
 * Pre-fix exploit summary:
 *  - PayPal branch captured body-supplied orderID with NO signature verification
 *    of any kind. Any caller could POST `{resource:{id:<pending order>}}` and
 *    have the order captured + wallet credited.
 *  - Stripe branch verified signature, but credited wallet by
 *    `existingTransaction.amount` with NO `expectedChargeCents` cross-check —
 *    re-opening the M11 baseAmount-tampering vector for any inbound Stripe event.
 *  - Razorpay branch used checkout-HMAC (`verifyRazorpayPayment`) — bypasses
 *    the dedicated webhook-secret path in `razorpay-webhook.js`.
 *
 * This test is a STATIC grep. It asserts:
 *  1. Route file does not define POST /api/transactions/webhook/:gateway.
 *  2. Route file does not define POST /api/api/transactions/webhook/:gateway.
 *  3. No route file `handler: 'transaction.handleWebhook'` binding string.
 *  4. Controller does not define an `async handleWebhook(...)` method.
 *  5. The gateway-specific webhook routes are STILL present (regression guard
 *     against accidentally nuking the legitimate ones).
 *
 * Run: cd serpbays_server && node scripts/test-generic-webhook-removed.js
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

const ROUTES = 'src/api/transaction/routes/transaction.js';
const CTRL   = 'src/api/transaction/controllers/transaction.js';
const routes = read(ROUTES);
const ctrl   = read(CTRL);

out('\n=== 1) Generic /api/transactions/webhook/:gateway path is gone ===');
assert(routes.length > 0, `${ROUTES} exists`);
assert(
  !/['"]\/api\/transactions\/webhook\/:gateway['"]/.test(routes),
  'no /api/transactions/webhook/:gateway path literal'
);

out('\n=== 2) Typo-duplicate /api/api/transactions/webhook/:gateway is gone ===');
assert(
  !/['"]\/api\/api\/transactions\/webhook\/:gateway['"]/.test(routes),
  'no /api/api/transactions/webhook/:gateway path literal'
);

out('\n=== 3) No `transaction.handleWebhook` handler-binding string ===');
// Forbid only handler bindings to the *generic* controller. The dedicated
// stripe-webhook.handleWebhook, paypal-webhook.handleWebhook, etc., are fine.
assert(
  !/handler\s*:\s*['"]transaction\.handleWebhook['"]/.test(routes),
  'no handler: "transaction.handleWebhook" binding'
);

out('\n=== 4) Controller has no `async handleWebhook(...)` method body ===');
assert(ctrl.length > 0, `${CTRL} exists`);
assert(
  !/^\s*async\s+handleWebhook\s*\(/m.test(ctrl),
  'no async handleWebhook(...) method body in controllers/transaction.js'
);

out('\n=== 5) Dedicated gateway-specific webhook routes still present ===');
// We must not have nuked these — they are the M11-hardened replacements.
assert(/['"]\/api\/transactions\/stripe-webhook['"]/.test(routes), 'stripe-webhook route present');
assert(/['"]\/api\/transactions\/paypal-webhook['"]/.test(routes), 'paypal-webhook route present');
assert(/['"]\/api\/transactions\/razorpay-webhook['"]/.test(routes), 'razorpay-webhook route present');
assert(/handler\s*:\s*['"]stripe-webhook\.handleWebhook['"]/.test(routes), 'stripe-webhook.handleWebhook binding');
assert(/handler\s*:\s*['"]paypal-webhook\.handleWebhook['"]/.test(routes), 'paypal-webhook.handleWebhook binding');
assert(/handler\s*:\s*['"]razorpay-webhook\.handleWebhook['"]/.test(routes), 'razorpay-webhook.handleWebhook binding');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
