#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 8: user-wallet + offer audit.
 *
 * Closes:
 *   - CATASTROPHIC: user-wallet.addFunds HTTP handler took {amount} from
 *     ctx.request.body and called addMainFunds(userId, amount) directly —
 *     NO payment-gateway verification, NO signature check. The Authenticated
 *     role had `api::user-wallet.user-wallet.addFunds` permission, so any
 *     logged-in user could POST /api/wallet/add-funds {amount: <arbitrary>}
 *     to credit their own wallet with arbitrary money. Free funds primitive.
 *     Now disabled (returns 410 Gone + warn log). Legitimate top-ups go
 *     through /api/transactions/payment + signature-verified gateway
 *     webhooks. The internal `addMainFunds(userId, amount, ...)` helper
 *     remains for those server-side credit paths.
 *   - LOW (defense-in-depth): offer.getStats had no admin check in handler
 *     (relied on permission grant — pre-fix only super_admin had the
 *     grant). Now explicit role.type ∈ {admin, super_admin} gate.
 *   - LOW (defense-in-depth): offer.validateCoupon / applyOffers /
 *     getApplicableOffers had no in-handler auth check (relied on permission
 *     grant). Now explicit `if (!userId) return ctx.unauthorized()`.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass8.js
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

const UW = read('src/api/user-wallet/controllers/user-wallet.js');
const OF = read('src/api/offer/controllers/offer.js');

out('\n=== 1) user-wallet.addFunds — HTTP path DISABLED ===');
const addFundsStart = UW.indexOf('async addFunds(ctx)');
const addFundsEnd   = UW.indexOf('async addPromoFunds(userId,');
const addFunds      = addFundsStart > 0 && addFundsEnd > addFundsStart ? UW.slice(addFundsStart, addFundsEnd) : '';
assert(addFunds.length > 0, 'addFunds body sliced');
// The HTTP handler must NOT call addMainFunds anymore (it's a free-money primitive)
assert(!/this\.addMainFunds\s*\(/.test(addFunds),
  'addFunds HTTP wrapper no longer calls this.addMainFunds (closes free-money primitive)');
assert(/ctx\.status\s*=\s*410/.test(addFunds),
  'returns HTTP 410 Gone');
assert(/strapi\.log\??\.warn\??\.\(/.test(addFunds),
  'warns server-side on any call (production alerting)');
// Body destructure must NOT pull caller-supplied amount
assert(!/const\s*\{[^}]*amount[^}]*\}\s*=\s*ctx\.request\.body/.test(addFunds),
  'no longer destructures amount from request body');

out('\n=== 2) Internal addMainFunds helper still exists for legitimate callers ===');
// Webhook controllers (paypal-webhook, razorpay-webhook, stripe-webhook,
// phonepe-webhook) credit wallets via this helper. It must remain.
assert(/async\s+addMainFunds\s*\(\s*userId\s*,\s*amount\s*,/.test(UW),
  'internal addMainFunds(userId, amount, ...) helper preserved');

out('\n=== 3) Other user-wallet HTTP handlers still derive identity from JWT ===');
// Quick spot-check: getBalance, getTransactions, createWallet use
// ctx.state.user.id, not caller-supplied userId.
for (const h of ['getBalance', 'getTransactions', 'createWallet']) {
  const start = UW.indexOf(`async ${h}(ctx)`);
  const tail  = UW.slice(start, start + 800);
  assert(/ctx\.state\?\.user\?\.id|ctx\.state\.user\.id/.test(tail),
    `${h} derives userId from ctx.state.user.id`);
}

out('\n=== 4) offer.getStats — explicit admin gate ===');
const gsStart = OF.indexOf('async getStats(ctx)');
const gsEnd   = OF.indexOf('async create(ctx)', gsStart);
const gs      = gsStart > 0 && gsEnd > gsStart ? OF.slice(gsStart, gsEnd) : '';
assert(/u\.role\.type\s*===\s*'admin'\s*\|\|\s*u\.role\.type\s*===\s*'super_admin'/.test(gs),
  'getStats checks role.type ∈ {admin, super_admin}');
assert(/if\s*\(\s*!isAdmin\s*\)\s*return\s+ctx\.forbidden/.test(gs),
  'getStats returns 403 for non-admins');

out('\n=== 5) offer.{getApplicableOffers, applyOffers, validateCoupon} — auth gates ===');
for (const h of ['getApplicableOffers', 'applyOffers', 'validateCoupon']) {
  const start = OF.indexOf(`async ${h}(ctx)`);
  // slice to next handler boundary
  const after = OF.slice(start, start + 1500);
  assert(/if\s*\(\s*!userId\s*\)\s*return\s+ctx\.unauthorized/.test(after),
    `${h} rejects callers without ctx.state.user`);
}
// validateCoupon also length-validates the couponCode (defeats pathological inputs)
const vcStart = OF.indexOf('async validateCoupon(ctx)');
const vcEnd   = OF.indexOf('async getStats(ctx)', vcStart);
const vc      = vcStart > 0 && vcEnd > vcStart ? OF.slice(vcStart, vcEnd) : '';
assert(/couponCode\.length\s*===\s*0\s*\|\|\s*couponCode\.length\s*>\s*64/.test(vc),
  'validateCoupon rejects pathological coupon lengths');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
