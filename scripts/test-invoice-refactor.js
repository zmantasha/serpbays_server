#!/usr/bin/env node
/**
 * Regression test — wallet-deposit invoice centralization.
 *
 * Verifies that:
 *   A. The invoice service is the single source of truth for wallet
 *      deposit invoices and reads the correct user-schema fields.
 *   B. Stripe webhook routes through the service (no local duplicate).
 *   C. Razorpay webhook calls the service from both success paths.
 *   D. PayPal webhook calls the service from its success path.
 *   E. Order / escrow / refund flows are untouched (no new invoice calls).
 *   F. PDF download template uses the SerpBays brand palette.
 *
 * Static checks only — runs offline against the source tree.
 *
 * Run: cd serpbays_server && node scripts/test-invoice-refactor.js
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');

const fs = require('fs');
let pass = 0, fail = 0;
const out = (...a) => process.stderr.write(a.join(' ') + '\n');
const assert = (cond, label) => {
  if (cond) { pass++; out('  PASS', label); }
  else      { fail++; out('  FAIL', label); }
};
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const SVC   = read('src/api/invoice/services/invoice.js');
const CTRL  = read('src/api/invoice/controllers/invoice.js');
const STRIPE = read('src/api/transaction/controllers/stripe-webhook.js');
const PAYPAL = read('src/api/transaction/controllers/paypal-webhook.js');
const RAZOR  = read('src/api/transaction/controllers/razorpay-webhook.js');
const ORDER  = read('src/api/order/controllers/order.js');
const TX_CTRL = read('src/api/transaction/controllers/transaction.js');

out('\n=== A. Centralized service shape + correctness ===');

assert(/createInvoiceForTransaction\s*\(/.test(SVC),
  'service exports createInvoiceForTransaction');
assert(/transaction\.type\s*!==\s*['"]deposit['"]/.test(SVC),
  'service rejects non-deposit transactions');
assert(/transactionStatus\s*!==\s*['"]success['"]/.test(SVC),
  'service rejects non-success transactions');

// Idempotency: must query existing invoice by transactionId before create.
assert(/\bfindOne\b[\s\S]{0,200}transactionId\s*:\s*txIdStr/.test(SVC),
  'service has idempotency check (findOne by transactionId)');

// Correct user-schema field reads — must use city/country/pincode (NOT
// the pre-refactor billingCity/billingCountry/billingPincode which are
// not on the user schema and rendered empty).
assert(/user\?\.city/.test(SVC),
  'service reads user.city (not user.billingCity)');
assert(/user\?\.country/.test(SVC),
  'service reads user.country (not user.billingCountry)');
assert(/user\?\.pincode/.test(SVC),
  'service reads user.pincode (not user.billingPincode)');
assert(/user\?\.vatGstNumber/.test(SVC),
  'service reads user.vatGstNumber');

// Service must NOT reference the non-existent fields.
assert(!/user\.billingCity\b|user\.billingCountry\b|user\.billingPincode\b/.test(SVC),
  'service has no references to non-existent user.billingCity/billingCountry/billingPincode');

// Service must link invoice back to transaction.
assert(/strapi\.entityService\.update\(\s*['"]api::transaction\.transaction['"][\s\S]{0,150}invoice:\s*created\.id/.test(SVC),
  'service links new invoice back to transaction.invoice');

// Currency resolution must have a fallback chain.
assert(/transaction\?\.currency[\s\S]{0,80}transaction\?\.metadata\?\.currency[\s\S]{0,80}USD/.test(SVC),
  'service resolves currency from tx → metadata → USD fallback');

// Service must not use draftAndPublish field (schema is draftAndPublish: false).
assert(!/publishedAt:\s*new Date/.test(SVC),
  'service does NOT set publishedAt (schema is draftAndPublish: false)');

out('\n=== B. Stripe — routed through service, local duplicate removed ===');

assert(/strapi\.service\(\s*['"]api::invoice\.invoice['"]\s*\)[\s\S]{0,80}createInvoiceForTransaction/.test(STRIPE),
  'Stripe webhook calls strapi.service(...).createInvoiceForTransaction');
assert(!/async\s+function\s+createInvoiceForTransaction\s*\(/.test(STRIPE),
  'Stripe webhook no longer has its own local createInvoiceForTransaction function');
assert(!/['"]Address on file['"]|['"]000000['"]/.test(STRIPE),
  'Stripe webhook no longer has placeholder billing strings (Address on file / 000000)');

out('\n=== C. Razorpay — both success paths invoke the centralized service ===');

assert(/_createDepositInvoice\s*\(/.test(RAZOR),
  'Razorpay webhook exposes _createDepositInvoice helper');
assert(/strapi\.service\(\s*['"]api::invoice\.invoice['"]\s*\)[\s\S]{0,80}createInvoiceForTransaction/.test(RAZOR),
  'Razorpay helper calls the centralized invoice service');

// handlePaymentCaptured calls _createDepositInvoice after wallet credit.
{
  const m = RAZOR.match(/async\s+handlePaymentCaptured\s*\(eventData\)[\s\S]*?(?=\n\s{2,4}async\s+\w+\s*\(|\n\}\)\);)/);
  const body = m ? m[0] : '';
  assert(/this\._createDepositInvoice/.test(body),
    'handlePaymentCaptured calls this._createDepositInvoice');
}

// handleOrderPaid calls _createDepositInvoice after wallet credit.
{
  const m = RAZOR.match(/async\s+handleOrderPaid\s*\(eventData\)[\s\S]*?(?=\n\s{2,4}async\s+\w+\s*\(|\n\}\)\);)/);
  const body = m ? m[0] : '';
  assert(/this\._createDepositInvoice/.test(body),
    'handleOrderPaid calls this._createDepositInvoice');
}

// updateTransactionStatus (the helper that the verifyPayment client-callback
// path uses for wallet credit) must also create the invoice. This is the
// path that actually fires in production — most Razorpay deposits arrive
// via the checkout SDK's verify call, NOT via the signed webhook.
{
  const m = RAZOR.match(/async\s+updateTransactionStatus\s*\([\s\S]*?(?=\n\s{2,4}async\s+\w+\s*\(|\n\}\)\);)/);
  const body = m ? m[0] : '';
  assert(/this\._createDepositInvoice/.test(body),
    'updateTransactionStatus calls this._createDepositInvoice (covers verifyPayment path)');
}

out('\n=== D. PayPal — success path invokes the centralized service ===');

assert(/_createDepositInvoice\s*\(/.test(PAYPAL),
  'PayPal webhook exposes _createDepositInvoice helper');
assert(/strapi\.service\(\s*['"]api::invoice\.invoice['"]\s*\)[\s\S]{0,80}createInvoiceForTransaction/.test(PAYPAL),
  'PayPal helper calls the centralized invoice service');

// PayPal must capture the create result so we have a transaction id to
// hand to the invoice service.
assert(/const\s+createdTx\s*=\s*await\s+strapi\.entityService\.create\(\s*['"]api::transaction\.transaction['"]/.test(PAYPAL),
  'PayPal captures createdTx from entityService.create');

// handlePaymentCompleted calls _createDepositInvoice after wallet credit.
{
  const m = PAYPAL.match(/async\s+handlePaymentCompleted\s*\(eventData\)[\s\S]*?(?=\n\s{2,4}async\s+\w+\s*\(|\n\s{2,4}_createDepositInvoice)/);
  const body = m ? m[0] : '';
  assert(/this\._createDepositInvoice/.test(body),
    'handlePaymentCompleted calls this._createDepositInvoice');
}

out('\n=== E. Order / escrow / refund flows untouched ===');

// order.js must not have started calling the invoice service (out of scope).
assert(!/strapi\.service\(\s*['"]api::invoice\.invoice['"]\s*\)[\s\S]{0,80}createInvoiceForTransaction/.test(ORDER),
  'order.js does NOT call the invoice service (escrow/order out of scope)');

// transaction.js — must call the invoice service ONLY from verifyPayPalPayment
// (the client-side PayPal verify path that credits wallet deposits).
{
  const m = TX_CTRL.match(/async\s+verifyPayPalPayment\s*\(ctx\)[\s\S]*?(?=\n\s{2,4}(?:\/\/[^\n]*\n\s{2,4})?async\s+\w+\s*\(|\n\}\)\);)/);
  const body = m ? m[0] : '';
  assert(/strapi\.service\(\s*['"]api::invoice\.invoice['"]\s*\)[\s\S]{0,80}createInvoiceForTransaction/.test(body),
    'verifyPayPalPayment calls the invoice service (covers PayPal client-callback path)');
}

// PayPal refund handler must not invoke invoice service.
{
  const m = PAYPAL.match(/async\s+handlePaymentRefunded\s*\(eventData\)[\s\S]*?(?=\n\s{2,4}async\s+\w+\s*\(|\n\s{2,4}_createDepositInvoice)/);
  const body = m ? m[0] : '';
  assert(!/_createDepositInvoice|createInvoiceForTransaction/.test(body),
    'PayPal refund handler does NOT create invoices');
}

// Razorpay failed-payment handler must not invoke invoice service.
{
  const m = RAZOR.match(/async\s+handlePaymentFailed\s*\(eventData\)[\s\S]*?(?=\n\s{2,4}async\s+\w+\s*\(|\n\s{2,4}_createDepositInvoice)/);
  const body = m ? m[0] : '';
  assert(!/_createDepositInvoice|createInvoiceForTransaction/.test(body),
    'Razorpay failed-payment handler does NOT create invoices');
}

out('\n=== F. PDF template uses the enterprise brand palette ===');

// Navy primary + coral accent (new enterprise palette).
assert(/#1E2A47/i.test(CTRL),
  'download template uses navy primary #1E2A47');
assert(/#FF6B47/i.test(CTRL),
  'download template uses coral accent #FF6B47');
assert(/#FFF1ED/i.test(CTRL),
  'download template uses light-coral surface #FFF1ED');
assert(/#E5E7EB/i.test(CTRL),
  'download template uses subtle border #E5E7EB');

// Old palettes must be gone — guard against partial refactors.
assert(!/['"]?#1a237e['"]?/i.test(CTRL),
  'download template no longer uses original #1a237e primary');
assert(!/['"]?#FFB088['"]?/i.test(CTRL),
  'download template no longer uses peachy #FFB088');

// Sections required by the design spec.
assert(/BILL TO/.test(CTRL),
  'download template has BILL TO section');
assert(/\bFROM\b/.test(CTRL),
  'download template has FROM (issuer) section');
assert(/PAYMENT SUMMARY/.test(CTRL),
  'download template has PAYMENT SUMMARY card');
assert(/SerpBays/.test(CTRL),
  'download template wordmark / footer mentions SerpBays');
assert(/erpBays/.test(CTRL),
  'wordmark splits S (coral) + erpBays (navy)');
assert(/system-generated and is valid without a signature/.test(CTRL),
  'download template includes the system-generated note');

// Icons + gateway badge helpers must exist.
assert(/iconCalendar|iconEmail|iconPin|iconGlobe|iconPhone|iconTag/.test(CTRL),
  'download template defines inline icon helpers');
assert(/drawGatewayBadge/.test(CTRL),
  'download template defines a gateway badge helper');
assert(/gatewayColor/.test(CTRL),
  'download template defines per-gateway colors (R/S/P badges)');

out('\n=== G. Stripe — invoiceTarget pipeline preserved ===');

// Make sure we didn't accidentally break the invoiceTarget setup or the
// catch-after-promise (logging on success / non-fatal on failure).
assert(/invoiceTarget\s*=\s*\{\s*transaction\s*,\s*user/.test(STRIPE),
  'Stripe still captures invoiceTarget = { transaction, user }');
assert(/\.catch\(\s*\(invoiceError\)\s*=>/.test(STRIPE),
  'Stripe invoice promise has a .catch handler (non-fatal)');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
