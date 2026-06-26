#!/usr/bin/env node
/**
 * Regression test for audit Wave-3 — four M11 bypass vectors fixed.
 *
 *   A. Currency-parameter inflation: client-supplied `currency` flowed
 *      to Stripe/PayPal/PhonePe untouched. With currency='IDR' the gateway
 *      charge becomes 100 IDR (~$0.006) while wallet credit (USD intent)
 *      stays $100 — up to ~17,000× inflation per call.
 *      Fix: server forces gateway-appropriate currency in createPayment.
 *
 *   B. PayPal createOrder dropped expectedChargeCents at the
 *      customIdData boundary in services/paypal.js, so the M11 webhook
 *      check found it undefined and fell into the grace-period
 *      warn-and-credit branch — effective no-op for ALL PayPal traffic.
 *      Fix: persist expectedChargeCents + expectedChargeUSD in customIdData.
 *
 *   C. PhonePe webhook (handleCallback + checkStatus) credited by the
 *      PhonePe-reported amount without comparing to the pending tx's
 *      metadata.expectedChargeCents. Fix: add M11 cross-check that
 *      writes a failed-tx row on mismatch and refuses to credit.
 *
 *   D. /api/transactions/pending + createPendingTransaction handler
 *      accepted client-supplied {amount, gateway, gatewayTransactionId}
 *      and created the pending row verbatim. Combined with the M11
 *      grace-period (until 2026-07-16) this let attackers plant a
 *      $1000 pending row that a real $1 gateway payment would credit.
 *      Cross-tree grep: 0 callers, 0 successful production hits in 7
 *      days. Fix: delete the route + handler.
 *
 * Static-grep tests across the 4 changed files.
 *
 * Run: cd serpbays_server && node scripts/test-wave3-m11-bypass-vectors.js
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

const CTRL_TX        = read('src/api/transaction/controllers/transaction.js');
const CTRL_PHONEPE   = read('src/api/transaction/controllers/phonepe-webhook.js');
const ROUTES_TX      = read('src/api/transaction/routes/transaction.js');
const SVC_PAYPAL     = read('src/api/transaction/services/paypal.js');

// ---------------- A: currency normalization ----------------
out('\n=== A) createPayment forces server-side currency for USD-denominated gateways ===');
assert(
  /CURRENCY_BY_GATEWAY\s*=\s*\{[^}]*stripe[^}]*paypal[^}]*phonepe[^}]*razorpay/.test(CTRL_TX),
  'CURRENCY_BY_GATEWAY map present with all 4 gateways'
);
assert(
  /stripe:\s*['"]USD['"]/.test(CTRL_TX) &&
  /paypal:\s*['"]USD['"]/.test(CTRL_TX) &&
  /phonepe:\s*['"]USD['"]/.test(CTRL_TX) &&
  /razorpay:\s*['"]INR['"]/.test(CTRL_TX),
  'Stripe/PayPal/PhonePe forced to USD; Razorpay forced to INR'
);
assert(
  /const\s+currency\s*=\s*serverCurrency/.test(CTRL_TX),
  'final `currency` binding is serverCurrency (client value discarded)'
);
assert(
  /CURRENCY_TAMPER/.test(CTRL_TX),
  'logs a CURRENCY_TAMPER warning when client-supplied currency differs from server-forced'
);

// ---------------- B: PayPal customIdData ----------------
out('\n=== B) paypal.js createOrder persists expectedChargeCents in custom_id ===');
// Slice out the customIdData block
const customStart = SVC_PAYPAL.indexOf('const customIdData');
const customEnd = SVC_PAYPAL.indexOf('};', customStart);
const customBlock = customStart >= 0 ? SVC_PAYPAL.slice(customStart, customEnd) : '';
assert(customBlock.length > 0, 'customIdData block located in services/paypal.js');
assert(
  /walletId\s*:/.test(customBlock),
  'customIdData includes walletId (control — unchanged)'
);
assert(
  /baseAmount\s*:/.test(customBlock),
  'customIdData includes baseAmount (control — unchanged)'
);
assert(
  /expectedChargeCents\s*:/.test(customBlock),
  'customIdData includes expectedChargeCents (NEW — the B fix)'
);
assert(
  /metadata\.expectedChargeCents/.test(customBlock),
  'expectedChargeCents value is sourced from metadata'
);

// ---------------- C: PhonePe M11 cross-check ----------------
out('\n=== C) phonepe-webhook handleCallback + checkStatus apply M11 cross-check ===');
// Both methods must contain the exact mismatch comparison + failed-tx branch.
const cbStart = CTRL_PHONEPE.indexOf('async handleCallback(ctx)');
const cbEnd   = CTRL_PHONEPE.indexOf('async checkStatus(ctx)');
const cbBody  = cbStart >= 0 && cbEnd > cbStart ? CTRL_PHONEPE.slice(cbStart, cbEnd) : '';
assert(cbBody.length > 0, 'handleCallback body sliced');
assert(
  /actualChargeCents\s*!==\s*Number\(\s*expectedChargeCents\s*\)/.test(cbBody),
  'handleCallback compares actualChargeCents vs expectedChargeCents'
);
assert(
  /transactionStatus:\s*['"]failed['"]/.test(cbBody) && /m11Error/.test(cbBody),
  'handleCallback writes a failed-tx + m11Error on mismatch'
);
assert(
  /GRACE_PERIOD_END/.test(cbBody) && /2026-07-16/.test(cbBody),
  'handleCallback uses 2026-07-16 grace-period boundary (matches other webhooks)'
);

const csStart = CTRL_PHONEPE.indexOf('async checkStatus(ctx)');
const csBody  = csStart >= 0 ? CTRL_PHONEPE.slice(csStart, csStart + 4500) : '';
assert(csBody.length > 0, 'checkStatus body sliced');
assert(
  /actualChargeCents\s*!==\s*Number\(\s*expectedChargeCents\s*\)/.test(csBody),
  'checkStatus compares actualChargeCents vs expectedChargeCents'
);
assert(
  /transactionStatus:\s*['"]failed['"]/.test(csBody) && /m11Error/.test(csBody),
  'checkStatus writes a failed-tx + m11Error on mismatch'
);
assert(
  /2026-07-16/.test(csBody),
  'checkStatus uses 2026-07-16 grace-period boundary'
);

// ---------------- D: /api/transactions/pending route + handler deleted ----------------
out('\n=== D) /api/transactions/pending route + handler deleted ===');
assert(
  !/['"]\/api\/transactions\/pending['"]/.test(ROUTES_TX),
  'route file no longer contains /api/transactions/pending path literal'
);
assert(
  !/handler\s*:\s*['"]transaction\.createPendingTransaction['"]/.test(ROUTES_TX),
  'route file no longer contains createPendingTransaction handler binding'
);
assert(
  !/^\s*async\s+createPendingTransaction\s*\(/m.test(CTRL_TX),
  'controller no longer defines async createPendingTransaction(...) method'
);

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
