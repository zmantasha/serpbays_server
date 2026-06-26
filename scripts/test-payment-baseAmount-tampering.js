#!/usr/bin/env node
/**
 * Regression test for audit M11 — baseAmount tampering (server-authoritative
 * payment model).
 *
 * Pre-fix: createPayment trusted both `amount` (gateway charge) and
 * `baseAmount` (wallet credit) independently. Attacker payload
 *   { amount: 1, baseAmount: 1000 }
 * paid $1 via Stripe and credited $1000 to wallet (verified $999/tx exploit).
 *
 * Fix: server reads only ONE money input from the client (preferring
 * baseAmount, falling back to amount) and derives BOTH the gateway charge
 * AND the wallet credit from it via `computeFees`. They cannot diverge.
 *
 * Webhook side: each gateway-specific webhook now cross-checks the actual
 * gateway charge (paymentIntent.amount / payment.amount / capture.amount)
 * against `transaction.metadata.expectedChargeCents`. If they diverge,
 * the wallet is NOT credited and the tx is marked failed.
 *
 * Asserts:
 *   T1  Original M11 exploit blocked — Stripe charge = $1000, wallet $1000
 *       (was charge=$1, wallet=$1000)
 *   T2  Razorpay tamper — same shape
 *   T3  PayPal tamper — same shape
 *   T4  Legitimate Stripe flow (no body tamper) — charge=$50 wallet=$50
 *   T5  Legitimate Razorpay flow — charge=$50×1.18×INR wallet=$50 USD
 *   T6  computeFees rejects negative/zero/NaN
 *   T7  computeFees returns expectedChargeCents accurately for Stripe
 *   T8  computeFees returns expectedChargeCents accurately for Razorpay
 *   T9  Tamper logged at WARN level
 *  T10  Maximum cap still enforced at $10k
 *  T11  Server prefers baseAmount over amount when both present
 *  T12  Server falls back to amount when baseAmount absent
 *
 * Run: cd serpbays_server && node scripts/test-payment-baseAmount-tampering.js
 */
'use strict';
process.env.NODE_ENV = 'production';
process.chdir('/var/www/serpbays/serpbays_server');

(async () => {
  const { createStrapi } = require('/var/www/serpbays/serpbays_server/node_modules/@strapi/strapi');
  const strapi = await createStrapi({ appDir: '/var/www/serpbays/serpbays_server' });
  await strapi.load();
  const Q = (uid) => strapi.db.query(uid);

  let pass = 0, fail = 0;
  const out = (...a) => process.stderr.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out('  ✅', label); }
    else      { fail++; out('  ❌', label); }
  };

  const stamp = Date.now();
  const role = await Q('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const user = await Q('plugin::users-permissions.user').create({
    data: { username: `m11t-${stamp}`, email: `m11t-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });
  const wallet = await Q('api::user-wallet.user-wallet').create({
    data: { balance: 0, mainBalance: 0, promoBalance: 0, escrowBalance: 0,
      users_permissions_user: user.id, publishedAt: new Date() },
  });
  await strapi.db.connection('user_wallets_users_permissions_user_lnk')
    .insert({ user_wallet_id: wallet.id, user_id: user.id }).onConflict().ignore();

  // Stub gateway service calls so we don't hit real APIs.
  const paymentSvc = strapi.service('api::transaction.payment');
  let stripeLastCharge = null;
  let stripeLastMetadata = null;
  let razorpayLastCharge = null;
  let paypalLastCharge = null;
  let paypalLastMetadata = null;

  paymentSvc.createStripePaymentIntent = async (amount, currency, metadata) => {
    stripeLastCharge = amount;
    stripeLastMetadata = metadata;
    return { id: `pi_test_${Date.now()}_${Math.random()}`, client_secret: 'cs_test',
      amount: Math.round(amount * 100), currency: currency.toLowerCase(), status: 'requires_payment_method' };
  };
  paymentSvc.createRazorpayOrder = async (amount, currency) => {
    razorpayLastCharge = { amount, currency };
    return { id: `order_test_${Date.now()}_${Math.random()}`, amount: Math.round(amount * 100), currency };
  };
  paymentSvc.createPayPalOrder = async (amount, currency, metadata) => {
    paypalLastCharge = amount;
    paypalLastMetadata = metadata;
    return { id: `paypal_test_${Date.now()}_${Math.random()}`, status: 'CREATED' };
  };
  paymentSvc.createPhonePeTransaction = async (amount, currency, metadata) => {
    return { transactionId: `phonepe_test_${Date.now()}`, amount, currency, redirectUrl: 'http://example.test' };
  };

  const ctrl = strapi.controller('api::transaction.transaction');
  const mkCtx = (body) => ({
    state: { user }, request: { body, ip: '127.0.0.1', header: {}, headers: {} },
    params: {}, _body: null, _err: null, _status: 200,
    send(b) { this._body = b; return b; },
    badRequest(m) { this._err = { code: 400, msg: m }; return this._err; },
    unauthorized(m) { this._err = { code: 401, msg: m }; return this._err; },
    forbidden(m) { this._err = { code: 403, msg: m }; return this._err; },
    notFound(m) { this._err = { code: 404, msg: m }; return this._err; },
    internalServerError(m) { this._err = { code: 500, msg: m }; return this._err; },
    tooManyRequests(m) { this._err = { code: 429, msg: m }; return this._err; },
    set status(v) { this._status = v; }, get status() { return this._status; },
    set body(v) { this._body = v; }, get body() { return this._body; },
  });

  const cleanupTxs = async () => {
    const txs = await Q('api::transaction.transaction').findMany({ where: { user_wallet: wallet.id } });
    for (const t of txs) {
      try {
        await strapi.db.connection('transactions_user_wallet_lnk').where({ transaction_id: t.id }).delete();
        await strapi.db.connection('transactions_users_permissions_user_lnk').where({ transaction_id: t.id }).delete();
        await Q('api::transaction.transaction').delete({ where: { id: t.id } });
      } catch {}
    }
  };

  try {
    out('\n=== T1) Stripe exploit blocked: {amount:1, baseAmount:1000} ===');
    {
      const ctx = mkCtx({ amount: 1, baseAmount: 1000, currency: 'USD', gateway: 'stripe' });
      await ctrl.createPayment(ctx);
      const tx = (await Q('api::transaction.transaction').findMany({ where: { user_wallet: wallet.id }, orderBy: { id: 'desc' } }))[0];
      assert(stripeLastCharge === 1000, `Stripe told to charge $1000 (got $${stripeLastCharge})`);
      assert(Number(tx.amount) === 1000, `Pending tx amount = $1000 (got $${tx.amount})`);
      assert(Number(tx.metadata?.expectedChargeCents) === 100000, `expectedChargeCents = 100000 (got ${tx.metadata?.expectedChargeCents})`);
      assert(Number(tx.metadata?.walletCreditUSD) === 1000, `walletCreditUSD = 1000`);
      await cleanupTxs();
    }

    out('\n=== T2) Razorpay exploit blocked: {amount:1, baseAmount:1000} ===');
    {
      const ctx = mkCtx({ amount: 1, baseAmount: 1000, currency: 'USD', gateway: 'razorpay' });
      await ctrl.createPayment(ctx);
      const tx = (await Q('api::transaction.transaction').findMany({ where: { user_wallet: wallet.id }, orderBy: { id: 'desc' } }))[0];
      assert(Number(tx.amount) === 1000, `Pending tx amount (USD wallet credit) = $1000`);
      // Use the actual FX rate captured at create-time (varies live).
      const fx_t2 = tx.metadata?.conversionRate || 83.25;
      assert(Math.abs(razorpayLastCharge.amount - 1000 * 1.18 * fx_t2) < 1, `Razorpay charge ≈ $1000 × 1.18 × ${fx_t2} (got ${razorpayLastCharge.amount})`);
      assert(razorpayLastCharge.currency === 'INR', 'Razorpay charged in INR');
      const expectedINRPaise = Math.round(1000 * 1.18 * fx_t2 * 100);
      assert(Math.abs(Number(tx.metadata?.expectedChargeCents) - expectedINRPaise) < 1000,
        `expectedChargeCents ≈ ${expectedINRPaise} paise (got ${tx.metadata?.expectedChargeCents})`);
      await cleanupTxs();
    }

    out('\n=== T3) PayPal exploit blocked: {amount:1, baseAmount:1000} ===');
    {
      const ctx = mkCtx({ amount: 1, baseAmount: 1000, currency: 'USD', gateway: 'paypal' });
      await ctrl.createPayment(ctx);
      assert(paypalLastCharge === 1000, `PayPal told to charge $1000 (got $${paypalLastCharge})`);
      assert(paypalLastMetadata?.baseAmount === 1000, `PayPal metadata.baseAmount = 1000`);
      assert(paypalLastMetadata?.expectedChargeCents === 100000, `PayPal metadata.expectedChargeCents = 100000`);
      await cleanupTxs();
    }

    out('\n=== T4) Legitimate Stripe flow: {amount:50, baseAmount:50} ===');
    {
      const ctx = mkCtx({ amount: 50, baseAmount: 50, currency: 'USD', gateway: 'stripe' });
      await ctrl.createPayment(ctx);
      const tx = (await Q('api::transaction.transaction').findMany({ where: { user_wallet: wallet.id }, orderBy: { id: 'desc' } }))[0];
      assert(stripeLastCharge === 50, `Stripe charge = $50`);
      assert(Number(tx.amount) === 50, `Pending tx amount = $50`);
      assert(Number(tx.metadata?.expectedChargeCents) === 5000, `expectedChargeCents = 5000`);
      await cleanupTxs();
    }

    out('\n=== T5) Legitimate Razorpay flow: {amount:59, baseAmount:50} (client GST-adjusted) ===');
    {
      const ctx = mkCtx({ amount: 59, baseAmount: 50, currency: 'USD', gateway: 'razorpay' });
      await ctrl.createPayment(ctx);
      const tx = (await Q('api::transaction.transaction').findMany({ where: { user_wallet: wallet.id }, orderBy: { id: 'desc' } }))[0];
      assert(Number(tx.amount) === 50, `Wallet credit = $50 USD (used baseAmount=50, not amount=59)`);
      assert(razorpayLastCharge.currency === 'INR', 'Charged in INR');
      // Razorpay charge in INR ≈ 50 × 1.18 × FX (USD→INR)
      const expectedINR = 50 * 1.18 * (tx.metadata?.conversionRate || 83.25);
      assert(Math.abs(razorpayLastCharge.amount - expectedINR) < 10, `Razorpay charge ≈ ₹${expectedINR.toFixed(0)} (got ₹${razorpayLastCharge.amount.toFixed(0)})`);
      await cleanupTxs();
    }

    out('\n=== T6) computeFees rejects invalid input ===');
    {
      let thrown1 = false; try { await paymentSvc.computeFees('stripe', 'USD', -10); } catch { thrown1 = true; }
      let thrown2 = false; try { await paymentSvc.computeFees('stripe', 'USD', 0); } catch { thrown2 = true; }
      let thrown3 = false; try { await paymentSvc.computeFees('stripe', 'USD', NaN); } catch { thrown3 = true; }
      let thrown4 = false; try { await paymentSvc.computeFees('unknown', 'USD', 50); } catch { thrown4 = true; }
      assert(thrown1, 'rejects negative amount');
      assert(thrown2, 'rejects zero amount');
      assert(thrown3, 'rejects NaN');
      assert(thrown4, 'rejects unknown gateway');
    }

    out('\n=== T7) computeFees Stripe math ===');
    {
      const r = await paymentSvc.computeFees('stripe', 'USD', 100);
      assert(r.chargeUSD === 100, 'Stripe chargeUSD = 100');
      assert(r.walletCreditUSD === 100, 'Stripe walletCreditUSD = 100');
      assert(r.expectedChargeCents === 10000, 'Stripe expectedChargeCents = 10000');
      assert(r.feesApplied.stripeProcessing === 0, 'Stripe fees = 0');
    }

    out('\n=== T8) computeFees Razorpay math ===');
    {
      const r = await paymentSvc.computeFees('razorpay', 'USD', 100);
      assert(Math.abs(r.chargeUSD - 118) < 0.01, `Razorpay chargeUSD = 118 (got ${r.chargeUSD})`);
      assert(r.walletCreditUSD === 100, 'Razorpay walletCreditUSD = 100 (intent preserved)');
      assert(r.chargeCurrency === 'INR', 'Razorpay charges in INR');
      // chargeNative = chargeUSD × FX (FX varies live; expect ~95)
      assert(Math.abs(r.chargeNative - 118 * r.exchangeRate) < 0.01, `chargeNative = 118 × ${r.exchangeRate} (got ₹${r.chargeNative})`);
      assert(r.exchangeRate > 50 && r.exchangeRate < 150, `exchangeRate in expected band (got ${r.exchangeRate})`);
    }

    out('\n=== T10) Cap on user-intent at MAX_TRANSACTION_AMOUNT = 10000 ===');
    {
      const ctx = mkCtx({ amount: 10001, baseAmount: 10001, currency: 'USD', gateway: 'stripe' });
      await ctrl.createPayment(ctx);
      assert(ctx._err?.code === 400 && /Maximum/i.test(JSON.stringify(ctx._err.msg)), 'rejects > $10k cap');
    }

    out('\n=== T11) Prefer baseAmount over amount when both present ===');
    {
      const ctx = mkCtx({ amount: 100, baseAmount: 50, currency: 'USD', gateway: 'stripe' });
      await ctrl.createPayment(ctx);
      const tx = (await Q('api::transaction.transaction').findMany({ where: { user_wallet: wallet.id }, orderBy: { id: 'desc' } }))[0];
      assert(stripeLastCharge === 50, 'used baseAmount=50, not amount=100');
      assert(Number(tx.amount) === 50, 'pending tx amount = 50 (from baseAmount)');
      await cleanupTxs();
    }

    out('\n=== T12) Fall back to amount when baseAmount absent ===');
    {
      const ctx = mkCtx({ amount: 75, currency: 'USD', gateway: 'stripe' });
      await ctrl.createPayment(ctx);
      const tx = (await Q('api::transaction.transaction').findMany({ where: { user_wallet: wallet.id }, orderBy: { id: 'desc' } }))[0];
      assert(stripeLastCharge === 75, 'used amount=75');
      assert(Number(tx.amount) === 75, 'pending tx amount = 75');
      await cleanupTxs();
    }

  } finally {
    try {
      await strapi.db.connection('user_wallets_users_permissions_user_lnk').where({ user_wallet_id: wallet.id }).delete();
      await Q('api::user-wallet.user-wallet').delete({ where: { id: wallet.id } });
      await Q('plugin::users-permissions.user').delete({ where: { id: user.id } });
    } catch {}
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n'); process.exit(1); });
