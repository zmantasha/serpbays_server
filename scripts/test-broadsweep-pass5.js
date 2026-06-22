#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 5: payment webhooks audit.
 *
 * Scope:
 *   - Stripe webhook had a NODE_ENV === 'development' bypass that
 *     accepted ctx.request.body as the canonical event with verification
 *     SKIPPED entirely. A production deploy with NODE_ENV unset / set to
 *     'development' for diagnostics would silently disable signature
 *     verification — anonymous attackers could forge payment_intent.succeeded
 *     events and trigger handlePaymentSucceeded → wallet credit. The
 *     handler now ALWAYS calls stripeService.verifyWebhookSignature and
 *     fails closed when secret / raw body / signature is missing.
 *   - Stripe handlers (handleWebhook, markTransactionFailed,
 *     checkTransactionStatus) no longer echo error.message in HTTP
 *     responses — Stripe error details would help a forged-webhook
 *     attacker probe failure modes.
 *
 * Coverage check for the other payment webhooks (Razorpay, PayPal, PhonePe):
 *   - Razorpay: signature MANDATORY (RAZORPAY_WEBHOOK_SECRET), HMAC-SHA256
 *     against rawBody, row-level lock + idempotency check inside the
 *     payment_captured handler. Confirmed OK in current source.
 *   - PayPal: signature verification via PayPal SDK (verifyPayPalWebhook).
 *     PAYPAL_WEBHOOK_ID mandatory; fails internalServerError when missing.
 *     Confirmed OK in current source.
 *   - PhonePe: handleCallback verifies via phonepeService.handleCallback +
 *     signature header. M11 amount-mismatch cross-check on COMPLETED.
 *     Confirmed OK in current source.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass5.js
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

const STRIPE = read('src/api/transaction/controllers/stripe-webhook.js');
const RAZOR  = read('src/api/transaction/controllers/razorpay-webhook.js');
const PAYPAL = read('src/api/transaction/controllers/paypal-webhook.js');
const PHONE  = read('src/api/transaction/controllers/phonepe-webhook.js');

out('\n=== 1) Stripe webhook — dev bypass REMOVED ===');
// The bypass branch had `NODE_ENV === 'development'` paired with
// `rawBody === JSON.stringify(ctx.request.body)`. Both patterns must
// be gone as ACTUAL CODE (comments documenting the prior bypass may
// remain).
const stripeCode = STRIPE.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/NODE_ENV\s*===\s*'development'\s*&&\s*rawBody\s*===\s*JSON\.stringify/.test(stripeCode),
  "no remaining `NODE_ENV === 'development' && rawBody === JSON.stringify(...)` bypass");
assert(!/Development mode:\s*Skipping signature verification/.test(stripeCode),
  '"Skipping signature verification" warn no longer reachable in code');
assert(!/Using parsed body for development/.test(stripeCode),
  'parsed-body reconstruction branch removed');
assert(!/event\s*=\s*ctx\.request\.body;/.test(stripeCode),
  'no code path assigns ctx.request.body to `event` (bypass result)');

out('\n=== 2) Stripe webhook — verifyWebhookSignature is the ONLY event source ===');
const handleStart = STRIPE.indexOf('async handleWebhook(ctx)');
const handleEnd   = STRIPE.indexOf('async markTransactionFailed(ctx)');
const handleBody  = handleStart > 0 && handleEnd > handleStart ? STRIPE.slice(handleStart, handleEnd) : '';
assert(handleBody.length > 0, 'handleWebhook body sliced');
assert(/stripeService\.verifyWebhookSignature\s*\(\s*rawBody\s*,\s*signature\s*,\s*webhookSecret\s*\)/.test(handleBody),
  'verifyWebhookSignature called with rawBody + signature + secret');
// Verify there is exactly ONE place that produces the `event` variable
const eventAssignments = (handleBody.match(/(const|let|var)\s+event\s*=/g) || []).length;
assert(eventAssignments === 1,
  `handleWebhook produces \`event\` exactly once (found ${eventAssignments})`);

out('\n=== 3) Stripe webhook — fails closed when secret / signature / raw body missing ===');
assert(/if\s*\(\s*!signature\s*\)[\s\S]{0,200}ctx\.badRequest/.test(handleBody),
  'missing signature → 400');
assert(/if\s*\(\s*!rawBody\s*\)[\s\S]{0,300}ctx\.badRequest/.test(handleBody),
  'missing raw body → 400');
assert(/if\s*\(\s*!webhookSecret\s*\)[\s\S]{0,250}ctx\.internalServerError/.test(handleBody),
  'missing STRIPE_WEBHOOK_SECRET → 500');

out('\n=== 4) Stripe handlers — no error.message echoes ===');
// All three Stripe handlers must NOT echo error.message in HTTP responses.
const stripeErrEcho = (stripeCode.match(/ctx\.(badRequest|internalServerError)\([^)]*error\.message/g) || []).length;
assert(stripeErrEcho === 0,
  `no error.message echo across stripe-webhook handlers (found ${stripeErrEcho})`);

out('\n=== 5) Razorpay webhook — signature verification MANDATORY ===');
assert(/const\s+webhookSecret\s*=\s*process\.env\.RAZORPAY_WEBHOOK_SECRET/.test(RAZOR),
  'reads RAZORPAY_WEBHOOK_SECRET');
assert(/if\s*\(\s*!webhookSecret\s*\)[\s\S]{0,300}internalServerError/.test(RAZOR),
  'fails closed when secret missing');
assert(/crypto\s*\.\s*createHmac\(\s*'sha256'\s*,\s*webhookSecret\s*\)/.test(RAZOR),
  'HMAC-SHA256 over webhookSecret');
assert(/razorpaySignature\s*!==\s*expectedSignature/.test(RAZOR),
  'signature compared (mismatch → forbidden)');
// Idempotency check on captured handler
assert(/transactionRow\.transaction_status\s*===\s*'success'[\s\S]{0,300}already processed/.test(RAZOR),
  'handlePaymentCaptured idempotency check on transaction_status === success');
// Row-level lock
assert(/\.forUpdate\(\)/.test(RAZOR),
  'handlePaymentCaptured uses .forUpdate() row lock');

out('\n=== 6) PayPal webhook — signature verification MANDATORY ===');
assert(/const\s+webhookId\s*=\s*process\.env\.PAYPAL_WEBHOOK_ID/.test(PAYPAL),
  'reads PAYPAL_WEBHOOK_ID');
assert(/if\s*\(\s*!webhookId\s*\)[\s\S]{0,300}internalServerError/.test(PAYPAL),
  'fails closed when webhook ID missing');
assert(/verifyPayPalWebhook\s*\(\s*headers\s*,\s*body\s*,\s*webhookId\s*\)/.test(PAYPAL),
  'verifyPayPalWebhook called');
assert(/!verification\.success\s*\|\|\s*!verification\.verified[\s\S]{0,500}forbidden/.test(PAYPAL),
  'mismatch → 403');

out('\n=== 7) PhonePe webhook — signature verification + M11 cross-check ===');
assert(/phonepeService\.handleCallback\s*\(\s*response\s*,\s*signature\s*\)/.test(PHONE),
  'handleCallback delegates to phonepeService for signature verification');
assert(/!callbackResult\.success[\s\S]{0,200}forbidden\('Invalid signature'\)/.test(PHONE),
  'mismatch → 403 with "Invalid signature"');
// M11 amount cross-check (Wave-3 fix already in tree)
assert(/actualChargeCents\s*!==\s*Number\(expectedChargeCents\)/.test(PHONE),
  'M11 amount mismatch check present');
assert(/transaction\.transactionStatus\s*===\s*'success'[\s\S]{0,200}Already processed/.test(PHONE),
  'callback idempotency check on transactionStatus === success');

out('\n=== 8) None of the webhook controllers ship debug/diagnostic bypasses ===');
for (const [name, body] of [
  ['stripe-webhook', stripeCode],
  ['razorpay-webhook', RAZOR],
  ['paypal-webhook', PAYPAL],
  ['phonepe-webhook', PHONE],
]) {
  // ANY of these patterns would indicate a verification bypass:
  const bypassPatterns = [
    /NODE_ENV\s*===\s*['"]development['"]\s*\)\s*\{[\s\S]{0,500}return/,  // dev-only bypass
    /skipSignatureVerification\s*=\s*true/,
    /process\.env\.SKIP_WEBHOOK_VERIFICATION/,
    /\/\*\s*skip\s*signature/i,
  ];
  const hasBypass = bypassPatterns.some(p => p.test(body));
  assert(!hasBypass, `${name}: no signature-verification bypass`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
