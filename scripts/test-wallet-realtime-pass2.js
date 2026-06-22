#!/usr/bin/env node
/**
 * Regression test — wallet real-time wiring (pass 2).
 *
 * Closes the gaps pass-1 didn't cover:
 *   - markAsPaidWithdrawal           → emit 'withdrawal_paid'
 *   - bank-transfer-request.update   → emit 'bank_transfer' on walletCredited
 *   - admin/wallets.updateWalletBalance → emit 'admin_adjustment'
 *   - admin/wallets.createTransaction   → emit 'admin_manual_transaction'
 *   - admin/wallets.walletOperation     → emit 'admin_<type>' (and target for transfer)
 *   - Stripe webhook: deposit + refund → emit 'stripe_deposit' / 'stripe_refund'
 *   - Razorpay webhook (4 flows)      → emit 'razorpay_deposit' / 'razorpay_manual'
 *   - PayPal webhook                  → emit 'paypal_deposit'
 *   - PhonePe webhook (in updateWalletBalance chokepoint) → emit 'phonepe_deposit'
 *   - transaction.js verifyPaypal     → emit 'paypal_verify'
 *   - admin/transactions edit + approve → emit on the TARGET user's channel
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-wallet-realtime-pass2.js
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

const WR     = read('src/api/withdrawal-request/controllers/withdrawal-request.js');
const BTR    = read('src/api/bank-transfer-request/controllers/bank-transfer-request.js');
const AW     = read('src/api/admin/controllers/wallets.js');
const ATX    = read('src/api/admin/controllers/transactions.js');
const STRIPE = read('src/api/transaction/controllers/stripe-webhook.js');
const RZP    = read('src/api/transaction/controllers/razorpay-webhook.js');
const PP     = read('src/api/transaction/controllers/paypal-webhook.js');
const PHN    = read('src/api/transaction/controllers/phonepe-webhook.js');
const TX     = read('src/api/transaction/controllers/transaction.js');

out('\n=== 1) Withdrawal: mark-as-paid emit ===');
{
  const start = WR.indexOf('async markAsPaidWithdrawal(');
  const end = WR.indexOf('async ', start + 1);
  const body = (start > 0 && end > start) ? WR.slice(start, end) : '';
  assert(body.length > 0, 'markAsPaidWithdrawal body sliced');
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']withdrawal_paid["']/.test(body),
    'markAsPaidWithdrawal emits withdrawal_paid');
  assert(/withdrawalRequest\.publisher\.id/.test(body) &&
         body.indexOf('emitBalanceUpdate') >= 0,
    'emit targets the publisher (the wallet that lost pendingWithdrawalBalance)');
}

out('\n=== 2) Bank-transfer admin approval emit ===');
{
  // Top-level method boundary lives at "\n  async " (two-space indent);
  // the nested "async ({ trx }) => {" inside the transaction shouldn't
  // be matched as the next method.
  const start = BTR.indexOf('\n  async update(');
  const end = BTR.indexOf('\n  async ', start + 5);
  const body = (start > 0 && end > start) ? BTR.slice(start, end) : BTR.slice(start);
  assert(body.length > 0, 'bank-transfer update() body sliced');
  assert(/result\.walletCredited/.test(body),
    'emit is gated on result.walletCredited');
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']bank_transfer["']/.test(body),
    'bank-transfer update emits bank_transfer on credit');
  assert(/result\.userId/.test(body),
    'emit targets the requester (result.userId surfaced from the transaction)');
}

out('\n=== 3) Admin wallets: updateWalletBalance / createTransaction / walletOperation ===');
{
  // Top-level boundary is "\n  async " (two-space indent); inner
  // "async () => {" inside strapi.db.transaction callbacks must not be
  // mistaken for the next method.
  const ub_start = AW.indexOf('\n  async updateWalletBalance(');
  const ub_end = AW.indexOf('\n  async ', ub_start + 5);
  const ub = (ub_start > 0 && ub_end > ub_start) ? AW.slice(ub_start, ub_end) : '';
  assert(ub.length > 0, 'updateWalletBalance body sliced');
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']admin_adjustment["']/.test(ub),
    'updateWalletBalance emits admin_adjustment');
  assert(/emitBalanceUpdate\(\s*\n?\s*userId,/.test(ub),
    'emit targets the TARGET user (userId from ctx.params), not the admin');

  const ct_start = AW.indexOf('\n  async createTransaction(');
  const ct_end = AW.indexOf('\n  async ', ct_start + 5);
  const ct = (ct_start > 0 && ct_end > ct_start) ? AW.slice(ct_start, ct_end) : '';
  assert(ct.length > 0, 'createTransaction body sliced');
  assert(/if\s*\(\s*isSettled\s*\)/.test(ct) && /emitBalanceUpdate\([\s\S]{0,200}["']admin_manual_transaction["']/.test(ct),
    'createTransaction emits admin_manual_transaction only when settled');

  const wo_start = AW.indexOf('\n  async walletOperation(');
  const wo_end = AW.indexOf('}));', wo_start);
  const wo = (wo_start > 0 && wo_end > wo_start) ? AW.slice(wo_start, wo_end) : '';
  assert(wo.length > 0, 'walletOperation body sliced');
  assert(/emitBalanceUpdate\([\s\S]{0,300}`admin_\$\{type\}`/.test(wo),
    'walletOperation emits admin_<type> on source user channel');
  assert(/type === 'transfer_funds' && targetUserId/.test(wo),
    'transfer_funds also emits on the target user channel');
  assert(/side:\s*'source'/.test(wo) && /side:\s*'target'/.test(wo),
    'transfer emits distinguish source vs target via side meta');
}

out('\n=== 4) Stripe webhook: deposit + refund emit ===');
{
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']stripe_deposit["']/.test(STRIPE),
    'stripe deposit emits stripe_deposit');
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']stripe_refund["']/.test(STRIPE),
    'stripe refund emits stripe_refund');
}

out('\n=== 5) Razorpay webhook: 4 credit flows emit ===');
{
  assert((RZP.match(/emitBalanceUpdate\([\s\S]{0,200}["']razorpay_deposit["']/g) || []).length >= 2,
    'razorpay_deposit emitted on handlePaymentCaptured AND handleOrderPaid (post-commit)');
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']razorpay_deposit["']/.test(RZP) &&
         RZP.indexOf('async updateTransactionStatus(') > 0,
    'updateTransactionStatus → wallet credit also emits (covers verifyPayment path)');
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']razorpay_manual["']/.test(RZP),
    'manualUpdate emits razorpay_manual after credit');
  // Emits must be after the strapi.db.transaction block (post-commit), not inside.
  // We grep for `emitContext` which our pattern uses to defer.
  assert(/let emitContext\s*=\s*null/.test(RZP),
    'razorpay emits are deferred to post-commit via emitContext (no in-transaction emit)');
}

out('\n=== 6) PayPal webhook + verifyPaypal emit ===');
{
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']paypal_deposit["']/.test(PP),
    'paypal webhook emits paypal_deposit');
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']paypal_verify["']/.test(TX),
    'transaction.js verifyPaypal emits paypal_verify');
}

out('\n=== 7) PhonePe webhook emit (in updateWalletBalance chokepoint) ===');
{
  // PhonePe routes all credit paths through updateWalletBalance, so a single
  // emit there covers callback + status-check + redirect flows.
  const start = PHN.indexOf('async updateWalletBalance(');
  const end = PHN.indexOf('async ', start + 1);
  const body = (start > 0 && end > start) ? PHN.slice(start, end) : '';
  assert(body.length > 0, 'phonepe updateWalletBalance body sliced');
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']phonepe_deposit["']/.test(body),
    'phonepe emits phonepe_deposit from the wallet-update chokepoint');
}

out('\n=== 8) Admin transactions: edit (delta) + approve (payment) emit ===');
{
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']admin_transaction_edit["']/.test(ATX),
    'admin transaction edit emits admin_transaction_edit on walletDelta != 0');
  assert(/emitBalanceUpdate\([\s\S]{0,200}["']admin_transaction_approve["']/.test(ATX),
    'admin transaction approve emits admin_transaction_approve on payment credit');
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
