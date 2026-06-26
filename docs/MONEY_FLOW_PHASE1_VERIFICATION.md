# Phase 1 Money-Flow Security Audit — Synthesizer Verdict Report

## Executive Summary

**6/6 findings CONFIRMED REAL by reviewer consensus.** 5 of 6 are ship-ready with a single consolidated fix; 1 (M11_BYPASSES) is a multi-vector bundle requiring sequenced rollout. **NO findings refuted.**

| # | Finding | Verdict | Effort | Priority | Implementation Ready |
|---|---------|---------|--------|----------|---------------------|
| 1 | C5 — fix-earnings ungated loop | real_ship_fix | S | P0 | YES — delete route + handler |
| 2 | C10 — hardcoded exchange-rate API key | real_ship_fix | S | P0 | YES — remove fallback + rotate |
| 3 | C9 — generic webhook bypass | real_ship_fix | S | P0 | YES — delete routes + handler |
| 4 | C4 — manual-update-razorpay admin gate | real_ship_fix | S | P0 | YES — route config change |
| 5 | C3 — verifyPayPalPayment walletId spoof | real_ship_fix | M | P0 | YES — controller rewrite |
| 6 | M11_BYPASSES (A/B/C/D/E) | real_but_complex | M-L | P1 | YES — sequenced rollout |

---

## Finding C3 — verifyPayPalPayment walletId spoof

**Consensus:** 3/3 reviewers `confirmed_real` (high confidence).

**Exploit shape:** `verifyPayPalPayment` at `/var/www/serpbays/serpbays_server/src/api/transaction/controllers/transaction.js:886-987` reads `walletId` directly from request body with no ownership check against `ctx.state.user`. Any authenticated user can call:
```
POST /api/transactions/verify-paypal
{ "orderId": "<any-completed-paypal-orderId>", "walletId": <ATTACKER_WALLET_ID> }
```
to credit their own wallet from any other user's PayPal order. Per call: full `purchase_units[0].amount.value`. Composite dedup `{gatewayTransactionId, user_wallet}` is bypassed because attacker controls `user_wallet`. Webhook stores `gatewayTransactionId=capture.id` while verify stores `=orderId` — two different keys for the same payment, so cross-channel dedup ALSO misses.

**Consolidated fix** (combines Security Eng #1 + QA #1 strongest elements):

File: `/var/www/serpbays/serpbays_server/src/api/transaction/controllers/transaction.js` — replace `verifyPayPalPayment` (lines 886-987):

```javascript
async verifyPayPalPayment(ctx) {
  try {
    const authUser = ctx.state.user;
    if (!authUser || !authUser.id) {
      return ctx.unauthorized('Authentication required');
    }
    const { orderId } = ctx.request.body || {};
    if (!orderId || typeof orderId !== 'string') {
      return ctx.badRequest('Order ID is required');
    }
    console.log(`[MANUAL PAYPAL VERIFY] user=${authUser.id} order=${orderId}`);

    // 1. Fetch authoritative order from PayPal
    const orderDetails = await strapi.service('api::transaction.payment').getPayPalOrderDetails(orderId);
    if (!orderDetails || !orderDetails.success) return ctx.badRequest('Failed to get PayPal order details');
    const order = orderDetails.order;
    if (order.status !== 'COMPLETED') return ctx.badRequest('PayPal order is not completed');

    const purchaseUnit = order.purchase_units && order.purchase_units[0];
    if (!purchaseUnit) return ctx.badRequest('PayPal order missing purchase unit');
    const capture = purchaseUnit.payments && purchaseUnit.payments.captures && purchaseUnit.payments.captures[0];
    if (!capture || !capture.id) return ctx.badRequest('PayPal order missing capture id');

    // 2. Parse server-set custom_id (NEVER trust client body for walletId)
    let walletIdFromOrder = null;
    let userIdFromOrder = null;
    let baseAmount = null;
    let expectedChargeCents = null;
    try {
      if (purchaseUnit.custom_id) {
        const cd = JSON.parse(purchaseUnit.custom_id);
        walletIdFromOrder = cd.walletId ? parseInt(cd.walletId, 10) : null;
        userIdFromOrder = cd.userId ? parseInt(cd.userId, 10) : null;
        baseAmount = cd.baseAmount != null ? parseFloat(cd.baseAmount) : null;
        expectedChargeCents = cd.expectedChargeCents != null ? Number(cd.expectedChargeCents) : null;
      }
    } catch (_) {
      const n = parseInt(purchaseUnit.custom_id, 10);
      if (Number.isFinite(n)) walletIdFromOrder = n;
    }
    if (!walletIdFromOrder) {
      strapi.log.error(`[MANUAL PAYPAL VERIFY] order ${orderId} missing walletId in custom_id`);
      return ctx.badRequest('PayPal order has no wallet metadata');
    }

    // 3. AUTHZ — wallet must belong to caller; custom_id.userId must match
    const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: { id: walletIdFromOrder },
      populate: { users_permissions_user: true }
    });
    if (!wallet) return ctx.badRequest('Wallet not found');
    const ownerId = wallet.users_permissions_user && wallet.users_permissions_user.id
      ? wallet.users_permissions_user.id : wallet.users_permissions_user;
    if (!ownerId || Number(ownerId) !== Number(authUser.id)) {
      strapi.log.warn(`[MANUAL PAYPAL VERIFY] AUTHZ_BYPASS_ATTEMPT user=${authUser.id} wallet=${walletIdFromOrder} owner=${ownerId} order=${orderId} ip=${ctx.request.ip}`);
      return ctx.forbidden('You are not authorized to verify this order');
    }
    if (userIdFromOrder && Number(userIdFromOrder) !== Number(authUser.id)) {
      strapi.log.warn(`[MANUAL PAYPAL VERIFY] AUTHZ_BYPASS_ATTEMPT user=${authUser.id} custom_id.userId=${userIdFromOrder}`);
      return ctx.forbidden('You are not authorized to verify this order');
    }

    // 4. M11 amount cross-check (mirror paypal-webhook.js)
    const paypalCaptureAmount = parseFloat(capture.amount.value);
    const actualChargeCents = Math.round(paypalCaptureAmount * 100);
    const GRACE_PERIOD_END = new Date('2026-07-16T00:00:00Z');
    if (Number.isFinite(expectedChargeCents) && expectedChargeCents > 0) {
      if (actualChargeCents !== expectedChargeCents) {
        strapi.log.error(`[MANUAL PAYPAL VERIFY] amount mismatch actual=${actualChargeCents}c expected=${expectedChargeCents}c order=${orderId}`);
        return ctx.badRequest('Payment amount mismatch');
      }
    } else if (new Date() > GRACE_PERIOD_END) {
      strapi.log.error(`[MANUAL PAYPAL VERIFY] missing expectedChargeCents post-grace, order=${orderId}`);
      return ctx.badRequest('Order missing required metadata');
    }

    const amountToCredit = baseAmount !== null && baseAmount > 0 ? baseAmount : paypalCaptureAmount;

    // 5. Atomic dedup + credit. Dedup on capture.id ALONE (no walletId in key)
    const knex = strapi.db.connection;
    let createdTxId = null;
    let alreadyProcessed = false;
    let newTotalBalance = null;
    await knex.transaction(async (trx) => {
      const dupe = await trx('transactions')
        .whereIn('gateway_transaction_id', [capture.id, orderId])
        .andWhere('gateway', 'paypal')
        .andWhere('transaction_status', 'success')
        .forUpdate()
        .first();
      if (dupe) { alreadyProcessed = true; createdTxId = dupe.id; return; }

      const walletRow = await trx('user_wallets').where({ id: walletIdFromOrder }).forUpdate().first();
      if (!walletRow) throw new Error('Wallet vanished mid-tx');
      const currentMain = parseFloat(walletRow.main_balance || 0);
      const currentPromo = parseFloat(walletRow.promo_balance || 0);
      const newMain = currentMain + amountToCredit;
      newTotalBalance = newMain + currentPromo;
      await trx('user_wallets').where({ id: walletIdFromOrder }).update({
        main_balance: newMain, balance: newTotalBalance, updated_at: new Date()
      });
    });

    if (alreadyProcessed) {
      return ctx.send({ success: true, message: 'Transaction already processed', transactionId: createdTxId });
    }

    const tx = await strapi.entityService.create('api::transaction.transaction', {
      data: {
        type: 'deposit', amount: amountToCredit, netAmount: amountToCredit,
        transactionStatus: 'success', gateway: 'paypal',
        gatewayTransactionId: capture.id,  // align with webhook key
        description: `PayPal payment - Manual verification (Order ${orderId})`,
        user_wallet: walletIdFromOrder, users_permissions_user: authUser.id,
        fund_source: 'main_fund', fee: 0,
        metadata: { orderId, captureId: capture.id, manualVerification: true, verifiedByUserId: authUser.id, processedAt: new Date().toISOString() },
        publishedAt: new Date()
      }
    });
    return ctx.send({ success: true, message: 'Payment verified and wallet updated', transaction: tx, newBalance: newTotalBalance });
  } catch (error) {
    console.error('[MANUAL PAYPAL VERIFY ERROR]', error);
    return ctx.internalServerError('Failed to verify PayPal payment');
  }
}
```

**Follow-up DB migration** (recommended, low-effort hardening):
```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_paypal_capture_id
  ON transactions (gateway_transaction_id)
  WHERE gateway = 'paypal' AND transaction_status = 'success';
```

**Regression tests** (must all pass):
1. AUTHZ cross-user: userB calls with userA's orderId → 403, no balance change on either wallet.
2. AUTHZ body-walletId-ignored: userA sends `{orderId, walletId: 9999}` → still credits walletA (from custom_id), bogus walletId ignored.
3. DEDUP webhook+verify: webhook fires first (writes capture.id), then verify call → 200 'already processed', no double-credit.
4. AMOUNT MISMATCH: capture amount ≠ expectedChargeCents → 400, wallet unchanged.
5. RACE: 10 parallel POSTs → exactly 1 credit, 1 transaction row.
6. UNAUTH: no JWT → 401.
7. BAD ORDER: missing custom_id → 400.
8. NON-COMPLETED: status='APPROVED' → 400.

**Bypass vectors identified** (follow-up findings):
- BV-C3.1 (critical): Same body-walletId pattern in verifyRazorpayPayment / verifyPhonePePayment / verifyStripePayment if present.
- BV-C3.2 (high): No DB-level UNIQUE on (gateway, gatewayTransactionId) — recommended.
- BV-C3.3 (critical): Manual-verify stores `orderId` while webhook stores `capture.id`. The fix aligns both on `capture.id`.
- BV-C3.4 (high): PayPal webhook itself dedup is `(capture.id, walletId)` — should be widened to capture.id alone for full cross-channel safety.

---

## Finding C4 — manual-update-razorpay missing admin gate

**Consensus:** 3/3 reviewers `confirmed_real` (high confidence).

**Exploit shape:** Route at `/var/www/serpbays/serpbays_server/src/api/transaction/routes/transaction.js:252-261` has `auth: { strategies: ['jwt'] }` with no scope and no admin policy. In Strapi 5, this passes ANY valid JWT without checking the users-permissions per-action grant (verified in plugin source: when `config.scope` is unset, the permission check short-circuits). Handler at `razorpay-webhook.js:751-800` (a) updates `transactionStatus` to caller-supplied value, (b) credits `transaction.amount` to the linked wallet — no ownership check, no signature check, no idempotency, no Razorpay API verification.

Any authenticated user can create their own pending Razorpay deposit for arbitrary amount, never pay Razorpay, then call:
```
POST /api/transactions/manual-update-razorpay
{ "order_id": "<their_pending_order>", "status": "success" }
```
to mint free wallet balance.

**Consolidated fix** (minimum: route config — Security Eng #2's pattern; recommended: pair with handler hardening):

**EDIT 1 (MUST-HAVE):** `/var/www/serpbays/serpbays_server/src/api/transaction/routes/transaction.js` lines 251-261:

```javascript
// Manual Razorpay transaction update (admin only)
{
  method: 'POST',
  path: '/api/transactions/manual-update-razorpay',
  handler: 'razorpay-webhook.manualUpdate',
  config: {
    auth: false,
    policies: ['global::is-admin'],
    middlewares: ['global::admin-jwt-auth']
  }
},
```
This mirrors the cleanup-pending-razorpay route at lines 263-272 (the established admin pattern in the same file).

**EDIT 2 (RECOMMENDED — defense in depth):** `/var/www/serpbays/serpbays_server/src/api/transaction/controllers/razorpay-webhook.js` lines 751-800 — replace `manualUpdate`:

```javascript
async manualUpdate(ctx) {
  try {
    const { order_id, status: requestedStatus } = ctx.request.body;
    if (!order_id || !requestedStatus) return ctx.badRequest('Missing order_id or status');

    const ALLOWED = ['success', 'failed', 'cancelled'];
    if (!ALLOWED.includes(requestedStatus)) return ctx.badRequest(`Status must be one of: ${ALLOWED.join(', ')}`);

    const adminUser = ctx.state.user;
    strapi.log.warn(`[RAZORPAY MANUAL] Admin ${adminUser?.id} (${adminUser?.email}) requesting ${order_id} -> ${requestedStatus}`);

    const transaction = await strapi.db.query('api::transaction.transaction').findOne({
      where: { gatewayTransactionId: order_id },
      populate: ['user_wallet']
    });
    if (!transaction) return ctx.notFound('Transaction not found');

    // Idempotency
    if (['success', 'failed', 'cancelled', 'refunded'].includes(transaction.transactionStatus)) {
      return ctx.send({ success: true, message: `Already terminal: ${transaction.transactionStatus}`, transactionId: transaction.id, alreadyProcessed: true });
    }

    // Razorpay-authoritative verification (refuse to trust admin-supplied status)
    if (requestedStatus === 'success') {
      let rzpPayments;
      try { rzpPayments = await razorpay.orders.fetchPayments(order_id); }
      catch (err) { return ctx.badRequest('Unable to verify with Razorpay'); }
      const captured = (rzpPayments?.items || []).find(p => p.status === 'captured');
      if (!captured) return ctx.badRequest('Razorpay reports no captured payment for this order');
      const expectedPaise = Math.round(parseFloat(transaction.amount) * 100);
      if (captured.amount !== expectedPaise) {
        strapi.log.error(`[RAZORPAY MANUAL] Amount mismatch tx=${expectedPaise} rzp=${captured.amount}`);
        return ctx.badRequest('Amount mismatch with Razorpay');
      }
    }

    // Atomic: re-read with FOR UPDATE, then update + credit
    await strapi.db.transaction(async ({ trx }) => {
      const fresh = await strapi.db.query('api::transaction.transaction').findOne({
        where: { id: transaction.id }, populate: ['user_wallet'], transacting: trx
      });
      if (['success', 'failed', 'cancelled'].includes(fresh.transactionStatus)) return;

      await strapi.db.query('api::transaction.transaction').update({
        where: { id: fresh.id },
        data: {
          transactionStatus: requestedStatus,
          payment_notes: `Manual update by admin ${adminUser?.id} (${adminUser?.email})`,
          updatedAt: new Date()
        },
        transacting: trx
      });

      if (requestedStatus === 'success' && fresh.user_wallet) {
        const w = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: fresh.user_wallet.id }, transacting: trx
        });
        const newMain = parseFloat(w.mainBalance || 0) + parseFloat(fresh.amount);
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: w.id },
          data: { mainBalance: newMain, balance: newMain + parseFloat(w.promoBalance || 0), updatedAt: new Date() },
          transacting: trx
        });
      }
    });

    return ctx.send({ success: true, message: `Updated to ${requestedStatus}`, transactionId: transaction.id });
  } catch (error) {
    strapi.log.error('[RAZORPAY MANUAL] Error:', error);
    return ctx.internalServerError('Manual update failed');
  }
}
```

**Regression tests:**
1. Non-admin JWT → 403.
2. No auth → 401.
3. Admin JWT + valid Razorpay-captured order → 200 + credit.
4. Idempotency: second call after success → 200 alreadyProcessed=true, no double-credit.
5. Razorpay reports no captured payment → 400, wallet unchanged.
6. Razorpay amount ≠ tx.amount → 400.
7. Status whitelist: 'pending'/'captured' → 400.
8. Concurrent: two parallel admin calls → exactly one credit.
9. Snapshot test on route config asserts policies includes 'global::is-admin'.

**Bypass vectors:**
- BV-C4.1 (high): Other manual-endpoint siblings — verifyRazorpayPayment (auth:false at route line 187), stripe-mark-failed. Audit every route in transaction.js for the scope-only-JWT pattern.
- BV-C4.2 (high): Insider/compromised admin can still mint money — handler hardening (EDIT 2) reduces this by requiring Razorpay-side confirmation.
- BV-C4.3 (high): Race between manualUpdate and real webhook — handler EDIT 2 closes via DB transaction; webhook path needs separate audit for the same race shape.
- BV-C4.4 (high): If is-admin policy keys on `role.type in {admin, super_admin}`, audit role-assignment surfaces (Clerk integration, signup flow) to ensure non-trusted users cannot be granted admin role.

---

## Finding C5 — fix-earnings ungated system-wide loop

**Consensus:** 2/3 reviewers `confirmed_real` (high), 1 reviewer `partial` (high — partial only because QA #3 noted a prior migration revoked the action from 'authenticated' role, but the underlying code-level vulnerability is real per all 3 reviewers).

**Exploit shape:** Two distinct bugs at `/var/www/serpbays/serpbays_server/src/api/user-wallet/controllers/user-wallet.js:725-831`:
1. Route at `routes/user-wallet.js:157-166` has `auth: {}, policies: []` — no admin gate at the route level. Currently mitigated only by a May 2026 DB permission revoke for 'authenticated' role; fragile against re-grants, re-seeds, DB restores.
2. Lines 763-779 falsely claim idempotency: when an `escrow_release` transaction already exists for an order, the code sums those amounts and ADDS them to the wallet balance again on every call. Comment says `// idempotent` — the implementation is the literal opposite. N calls → N×inflation of every publisher's balance.

**Consolidated fix** (unanimous recommendation: DELETE both route and handler — Senior Dev #3, Security Eng #3, QA #3 all agree):

**EDIT 1:** `/var/www/serpbays/serpbays_server/src/api/user-wallet/routes/user-wallet.js` — delete lines 157-166 (the fix-earnings route block, with leading comma on line 156).

**EDIT 2:** `/var/www/serpbays/serpbays_server/src/api/user-wallet/controllers/user-wallet.js` — delete the entire `fixCompletedOrderEarnings` method (lines 725-831).

**EDIT 3 (recommended follow-up migration):** Create `database/migrations/2026.06.17T00.00.00.security-purge-fix-earnings-perm.js`:
```javascript
'use strict';
module.exports = {
  async up(knex) {
    const action = 'api::user-wallet.user-wallet.fixCompletedOrderEarnings';
    await knex.raw(`DELETE FROM up_permissions_role_lnk WHERE permission_id IN (SELECT id FROM up_permissions WHERE action = ?)`, [action]);
    await knex.raw(`DELETE FROM up_permissions WHERE action = ?`, [action]);
  },
};
```

**Why deletion over admin-gating:** The handler's core logic (the lines 763-779 'idempotency' branch) is fundamentally broken. Even with admin gate, an admin double-click doubles every publisher's balance. Backfill needs (if any) belong in `scripts/` with `--confirm` flag, atomic per-order DB transactions, and SELECT FOR UPDATE wallet locking.

**Regression tests:**
1. POST /api/wallet/fix-earnings → 404 (route gone).
2. Controller export: `strapi.controller('api::user-wallet.user-wallet').fixCompletedOrderEarnings === undefined`.
3. `grep -r 'fixCompletedOrderEarnings' src/` returns 0 matches.
4. Snapshot wallet balances pre/post deploy — must match (no migration ran).
5. After EDIT 3 migration: `SELECT COUNT(*) FROM up_permissions WHERE action='...fixCompletedOrderEarnings'` returns 0.

**Bypass vectors:**
- BV-C5.1 (critical): Other wallet-balance-mutation primitives (`addPromoFunds`, `addMainFunds`, `getOrCreateWallet`) and scripts (`scripts/fix-wallet-balances.js`, `scripts/fix-balance-sync.js`, etc.) deserve the same lens.
- BV-C5.2 (high): `api::user-wallet.wallet.addPromoFunds` was also revoked in the May 2026 migration — confirm its route + handler is similarly hardened.
- BV-C5.3 (high): Code-level race condition pattern (read balance → add → write) exists codebase-wide. Need SELECT FOR UPDATE or atomic `balance = balance + $1` SQL everywhere.
- BV-C5.4 (high): Missing partial unique index on `transactions(order_id, user_wallet_id) WHERE type='escrow_release'`.
- BV-C5.5 (low): Duplicate code trees at `/var/www/serpbays/src/...` and `/var/www/serpbays/serpbays_server/serpbays_server/src/...` — verify deploy root.

---

## Finding C9 — generic webhook bypasses signature + M11

**Consensus:** 3/3 reviewers `confirmed_real` (high confidence).

**Exploit shape:** Two routes at `/var/www/serpbays/serpbays_server/src/api/transaction/routes/transaction.js:129-144` (`/api/transactions/webhook/:gateway` and `/api/api/transactions/webhook/:gateway`, both `auth:false`) dispatch to `transaction.handleWebhook` at `controllers/transaction.js:397-748`. This generic handler:
1. **PayPal branch (lines 485-537):** NO signature verification (dedicated paypal-webhook.js:24-44 does check `paypal-transmission-sig`).
2. **All gateways:** NO M11 expectedChargeCents amount cross-check (dedicated per-gateway handlers enforce this at paypal-webhook.js:172-217, razorpay-webhook.js:134-175, stripe-webhook.js:386-417).

PoC (PayPal, no signature):
```bash
curl -X POST https://api.serpbays.com/api/transactions/webhook/paypal \
  -H 'Content-Type: application/json' \
  -d '{"resource":{"id":"<any-pending-paypal-orderId>"}}'
```
Handler captures the order (PayPal API allows any caller with merchant credentials), then credits `existingTransaction.amount` to the linked wallet — `existingTransaction.amount` is the server-stored base wallet amount that can be inflated via `/api/transactions/pending` (Vector E of M11_BYPASSES).

No frontend caller depends on these routes (verified by grep across server + client).

**Consolidated fix:**

**EDIT 1:** `/var/www/serpbays/serpbays_server/src/api/transaction/routes/transaction.js` — DELETE both route entries at lines 129-144.

**EDIT 2:** `/var/www/serpbays/serpbays_server/src/api/transaction/controllers/transaction.js` — replace `handleWebhook` method body (lines 397-748) with deny stub:

```javascript
// DEPRECATED 2026-06-17 — generic webhook removed for security (M11 + PayPal sig bypass).
// Use per-gateway webhook routes: paypal-webhook / razorpay-webhook / stripe-webhook / phonepe-callback.
async handleWebhook(ctx) {
  const gw = ctx.params?.gateway || 'unknown';
  strapi.log.error(`[SECURITY] Deprecated generic webhook endpoint hit: gateway=${gw} ip=${ctx.request.ip} ua=${ctx.request?.headers?.['user-agent']}`);
  ctx.status = 410;
  return { error: 'Endpoint retired. Use per-gateway webhook URL.' };
},
```

**Regression tests:**
1. `POST /api/transactions/webhook/paypal` → 404 (or 410 if stub retained).
2. `POST /api/api/transactions/webhook/paypal` → 404/410.
3. `POST /api/transactions/paypal-webhook` (per-gateway) without signature → 403 (NOT 404 — proves dedicated route still wired).
4. Route table assertion: no route entry has handler `transaction.handleWebhook` or path `/webhook/:gateway`.
5. Controller surface: `controller.handleWebhook` is undefined OR returns 410 deterministically.

**Production verification:**
1. `curl -i -X POST https://prod-host/api/transactions/webhook/paypal -d '{"resource":{"id":"deadbeef"}}'` → expect 404/410, NOT 200.
2. Grep nginx logs over 24h for `/api/transactions/webhook/` — zero legitimate hits expected.
3. Confirm per-gateway endpoints still see traffic (success `[STRIPE WEBHOOK] ✅` / `[PAYPAL WEBHOOK] ✅` logs).
4. Verify gateway dashboards (PayPal/Stripe/Razorpay/PhonePe) point ONLY at the dedicated `-webhook` URLs.

**Bypass vectors:**
- BV-C9.1 (high): PhonePe was not in the generic switch — but the PhonePe per-gateway endpoint also lacks M11 (see M11_BYPASSES Vector D).
- BV-C9.2 (high): Reverse-proxy rewrites — grep nginx/CDN config for any rule mapping per-gateway URL to the generic path (or vice versa).
- BV-C9.3 (high): `createPendingTransaction` (controllers/transaction.js:774-825) accepts user-controlled `amount` and `gatewayTransactionId` — this is the wedge that lets future webhook paths credit attacker-set amounts (also covered in M11_BYPASSES Vector E).
- BV-C9.4 (critical): `capturePayPalPayment` at services/payment.js:210-216 is callable from anywhere a PayPal orderID is known — audit `verifyPayPalPayment` (covered by C3) and any other consumer.
- BV-C9.5 (high): Race-condition / idempotency on per-gateway paths — verify `gatewayTransactionId` has a DB UNIQUE constraint with status='success' filter.

---

## Finding C10 — hardcoded ExchangeRate-API key in public repo

**Consensus:** 2/2 reviewers `confirmed_real` (high confidence).

**Exploit shape:** `/var/www/serpbays/serpbays_server/src/api/payment-gateways/services/exchange-rate.js:14` contains a hardcoded fallback API key:
```javascript
const EXCHANGE_RATE_API_KEY = process.env.EXCHANGE_RATE_API_KEY || '[REDACTED-rotated-2026-06-17]';
```
The repo `github.com/zmantasha/serpbays_server` is PUBLIC. The key is LIVE — verified by DevOps #2 with `curl 'https://v6.exchangerate-api.com/v6/[REDACTED-rotated-2026-06-17]/latest/USD'` returning `{"result":"success",...}`. Production has no `EXCHANGE_RATE_API_KEY` env var set — the hardcoded fallback IS the production key. Also leaked in `docs/MONEY_FLOW_SECURITY_AUDIT.md:186-187`.

**Impact:** (a) Direct quota burn + overage fees ($30-$2000/mo); (b) FX accuracy attack — if attacker exhausts quota, Razorpay/PhonePe USD→INR conversions fall through to stale `FALLBACK_USD_TO_INR=83.25`, creating per-transaction monetary discrepancies; (c) SOC2/disclosure risk.

**Consolidated fix:**

**EDIT 1:** `/var/www/serpbays/serpbays_server/src/api/payment-gateways/services/exchange-rate.js` lines 13-16:

```javascript
// API configuration
// SECURITY: API key MUST come from environment. Never hardcode here — repo is public.
// The previous hardcoded key has been ROTATED at provider — see ops runbook.
const EXCHANGE_RATE_API_KEY = process.env.EXCHANGE_RATE_API_KEY || null;
const EXCHANGE_RATE_API_URL = EXCHANGE_RATE_API_KEY
  ? `https://v6.exchangerate-api.com/v6/${EXCHANGE_RATE_API_KEY}/latest/USD`
  : null;
const FALLBACK_USD_TO_INR = parseFloat(process.env.USD_TO_INR_RATE || '83.25');
```

Then in `getExchangeRate` (around line 25-26), add hard guard BEFORE the try block:
```javascript
if (!EXCHANGE_RATE_API_KEY) {
  if (to === 'INR') {
    if (!global.__exchangeRateKeyWarned) {
      strapi.log.error('[EXCHANGE RATE] EXCHANGE_RATE_API_KEY not configured. Using fallback rate. Set env var in production.');
      global.__exchangeRateKeyWarned = true;
    }
    return FALLBACK_USD_TO_INR;
  }
  throw new Error('EXCHANGE_RATE_API_KEY not configured and no fallback exists for ' + to);
}
```

**EDIT 2:** `/var/www/serpbays/serpbays_server/docs/MONEY_FLOW_SECURITY_AUDIT.md:186-187` — replace literal `[REDACTED-rotated-2026-06-17]` with `<REDACTED-KEY>`.

**EDIT 3:** `/var/www/serpbays/serpbays_server/.env.example` — append:
```
# ExchangeRate-API (https://app.exchangerate-api.com) — required for live USD->INR FX
EXCHANGE_RATE_API_KEY=
USD_TO_INR_RATE=83.25
```

**MANDATORY OUT-OF-BAND ACTIONS (must accompany merge):**
1. **Rotate key** at exchangerate-api.com dashboard (revoke `[REDACTED-rotated-2026-06-17]`, issue new).
2. Set NEW key on prod/staging/CI env BEFORE merging code.
3. Verify duplicate file copies at `/var/www/serpbays/src/...` and `/var/www/serpbays/serpbays_server/serpbays_server/src/...` are stale (not deploy roots) — patch or delete if active.
4. Enable GitHub secret-scanning + push-protection on the repo.

**Regression tests:**
1. STATIC: `grep -r '[REDACTED-rotated-2026-06-17]' src/` returns 0. Add to CI.
2. UNIT: with EXCHANGE_RATE_API_KEY unset, `getExchangeRate('USD','INR')` returns 83.25, makes NO HTTP call (mock fetch spy: 0 calls).
3. UNIT: with EXCHANGE_RATE_API_KEY='testkey123' set, mocked fetch is called with URL containing 'testkey123' and NOT '[REDACTED-rotated-2026-06-17]'.
4. UNIT: with key unset and `to='EUR'`, throws (no silent fallback for non-INR).
5. INTEGRATION: POST /api/transactions/payment with currency=INR/gateway=razorpay returns 200 with conversionRate=83.25 fallback.
6. STATIC: grep `docs/` tree for the literal key returns 0.

**Production verification:**
1. SSH prod: `env | grep EXCHANGE_RATE_API_KEY` shows NEW key (not 123a3c87...).
2. `grep -r '[REDACTED-rotated-2026-06-17]' /var/www/serpbays/src` → 0 hits.
3. `curl https://v6.exchangerate-api.com/v6/[REDACTED-rotated-2026-06-17]/latest/USD` → `invalid-key` (proves rotation happened).
4. Trigger live INR rate fetch → log `[EXCHANGE RATE] Fresh rate fetched` with non-83.25 value.
5. chmod 600 on .env file.

**Bypass vectors:**
- BV-C10.1 (critical): Git history retains the key on every branch (commit `d0f0b6c`). Rotation at provider is the ONLY effective remediation — history rewrite (BFG/git-filter-repo) optional but disruptive.
- BV-C10.2 (high): Other `process.env.X || 'literal'` patterns codebase-wide — repo-wide grep for `process.env.*_KEY.*||` and `process.env.*SECRET.*||` as follow-up.
- BV-C10.3 (high): Next.js client bundles (`serpbays_client/.next/static/`) may have baked-in `NEXT_PUBLIC_*` env values — separate audit.
- BV-C10.4 (critical): Three duplicate copies of `exchange-rate.js` exist — implementer must verify build root and patch consistently.
- BV-C10.5 (medium): No CI secret-scanning gate — add gitleaks/trufflehog pre-commit hook.
- BV-C10.6 (medium): `FALLBACK_USD_TO_INR=83.25` is stale — every fallback-path INR transaction has systematic FX discrepancy.

---

## Finding M11_BYPASSES — five bypass vectors of M11 hardening

**Consensus:** 4/4 reviewers `confirmed_real` (high confidence). All 5 vectors (A/B/C/D/E) corroborated.

### Vector A — Currency swap (CRITICAL, all gateways)

**Exploit:** `controllers/transaction.js:37` destructures `currency = body.currency` with default 'USD' but no whitelist. `services/payment.js:33-104` `computeFees` builds `chargeCurrency: upperCurrency` (client-controlled) and `expectedChargeCents: Math.round(chargeUSD * 100)` (currency-agnostic). Result: client sends `currency:'INR', baseAmount:100` → Stripe charges ₹100 (~$1.20), webhook receives `paymentIntent.amount=10000` paise, M11 check `10000===10000` PASSES, wallet credited $100 USD. ~83× amplification per call.

### Vector B — PayPal customId drops expectedChargeCents

**Exploit:** `services/paypal.js:51-56` builds `customIdData = {walletId, baseAmount, totalAmount, userId}` — drops `expectedChargeCents` even though controller passes it. Webhook at `paypal-webhook.js:156` reads `customData.expectedChargeCents → undefined → Number.isFinite(undefined) === false` → falls into grace-period branch (`GRACE_PERIOD_END=2026-07-16`, today `2026-06-17`) which only logs warning. M11 amount check effectively disabled for ALL PayPal flows until 2026-07-16.

### Vector C — Generic webhook (overlaps with C9)

Already covered in C9. Listed here for the M11 lens: this path skips amount cross-check on ALL gateways.

### Vector D — PhonePe webhook missing M11 + USD/INR confusion

**Exploit:** `phonepe-webhook.js:13-86` `handleCallback` and `:92-162` `checkStatus` call `updateWalletBalance(walletId, amount, currency)` with PhonePe's amount (rupees) and NO `expectedChargeCents` check. Additionally, controller at `controllers/transaction.js:240` passes `parsedAmount` (USD) to `createPhonePeTransaction`, which at `services/phonepe.js:64` does `Math.round(amount * 100)` interpreting USD-numbers as paise. Net effect: user pays ₹100 (~$1.20), wallet credited $100 USD-as-INR (≈$83×). Baseline broken without any tamper.

### Vector E — createPendingTransaction lets caller plant amount

**Exploit:** `controllers/transaction.js:774-825` accepts client-supplied `{amount, currency, gateway, gatewayTransactionId, walletId}`. Validates wallet ownership but stores user-supplied amount with no computeFees, no expectedChargeCents. Attacker plants `amount=99999, gatewayTransactionId=<real_paypal_orderId>` before legitimate flow writes a row — then legitimate webhook credits the planted amount.

### Consolidated fix — sequenced rollout (effort: M; recommend feature flag per-vector)

**FIX 1 (Vector A) — Pin chargeCurrency in computeFees:**

File: `src/api/transaction/services/payment.js` — replace `computeFees` opening lines:
```javascript
const ALLOWED_CURRENCY = Object.freeze({
  stripe: ['USD'], paypal: ['USD'], phonepe: ['INR'], razorpay: ['INR']
});
async function computeFees(strapi, gateway, currency, amountUSD) {
  if (typeof amountUSD !== 'number' || !isFinite(amountUSD) || amountUSD <= 0) {
    throw new Error('computeFees: amountUSD must be a positive finite number');
  }
  const lowerGateway = (gateway || '').toLowerCase();
  const allowed = ALLOWED_CURRENCY[lowerGateway];
  if (!allowed) throw new Error(`computeFees: unknown gateway '${gateway}'`);
  const requested = (currency || allowed[0]).toUpperCase();
  if (!allowed.includes(requested)) {
    throw new Error(`computeFees: gateway '${gateway}' does not accept currency '${requested}'`);
  }
  const upperCurrency = allowed[0]; // server-pinned
  // ... rest of switch statement uses upperCurrency
```

File: `src/api/transaction/controllers/transaction.js:37` — remove `currency` from destructure:
```javascript
const { amount, baseAmount, gateway } = ctx.request.body;
if (ctx.request.body.currency && String(ctx.request.body.currency).toUpperCase() !== 'USD' && (gateway || '').toLowerCase() !== 'razorpay') {
  strapi.log.warn(`[PAYMENT M11] client sent currency=${ctx.request.body.currency} — ignored`);
}
// then use feeBreakdown.chargeCurrency everywhere downstream (lines 198, 204, 229, 240, 263, 316)
```

File: `src/api/transaction/services/stripe-service.js:29` — restrict whitelist:
```javascript
const supportedCurrencies = ['usd'];  // wallet is USD; was ['usd','eur','gbp','inr']
```

**FIX 2 (Vector B) — Include expectedChargeCents in PayPal custom_id:**

File: `src/api/transaction/services/paypal.js:51-56` — replace customIdData:
```javascript
const customIdData = {
  walletId: metadata.walletId || null,
  baseAmount: metadata.baseAmount != null ? parseFloat(metadata.baseAmount) : null,
  totalAmount: amount,
  userId: metadata.userId || null,
  expectedChargeCents: metadata.expectedChargeCents != null ? Number(metadata.expectedChargeCents) : null,
  expectedCurrency: (currency || 'USD').toUpperCase()
};
if (!Number.isFinite(customIdData.expectedChargeCents) || customIdData.expectedChargeCents <= 0) {
  throw new Error('paypal.createOrder: expectedChargeCents is required (M11 invariant)');
}
```

Also update `paypal-webhook.js:179-219` to:
- read `expectedCurrency` from custom_id; refuse on currency mismatch.
- Replace GRACE_PERIOD with env var `PAYPAL_M11_FIX_DEPLOY_TS` (~deploy + 7 days). Use `order.create_time` to determine if grace applies; new orders strict, old orders graced.

**FIX 3 (Vector C) — covered by Finding C9 (delete generic routes).**

**FIX 4 (Vector D) — PhonePe M11 + USD/INR fix:**

File: `src/api/transaction/controllers/phonepe-webhook.js` — in `handleCallback` (and `checkStatus`), insert M11 check before wallet credit:
```javascript
if (state === 'COMPLETED') {
  const expectedChargeCents = Number(transaction.metadata?.expectedChargeCents);
  const actualChargeCents = Math.round(Number(amount) * 100);
  const FIX_DEPLOY_TS = new Date(process.env.PHONEPE_M11_FIX_DEPLOY_TS || '2026-06-18T00:00:00Z');
  if (Number.isFinite(expectedChargeCents) && expectedChargeCents > 0) {
    if (Math.abs(actualChargeCents - expectedChargeCents) > 1) {
      strapi.log.error(`[PHONEPE CALLBACK] amount mismatch — REFUSING actual=${actualChargeCents}p expected=${expectedChargeCents}p`);
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: { transactionStatus: 'failed', metadata: { ...transaction.metadata, error: 'amount_mismatch', actualChargeCents, expectedChargeCents } }
      });
      return ctx.send({ success: true, status: 'amount_mismatch' });
    }
  } else if (new Date(transaction.createdAt) > FIX_DEPLOY_TS) {
    strapi.log.error(`[PHONEPE CALLBACK] missing expectedChargeCents — REFUSING`);
    return ctx.send({ success: true, status: 'missing_expected_amount' });
  }
  // CRITICAL: credit transaction.amount (USD wallet credit), NOT PhonePe's INR amount
  await this.updateWalletBalance(transaction.user_wallet.id, parseFloat(transaction.amount), 'USD');
}
```

Also in `controllers/transaction.js:314-316`, fix the PhonePe storage:
```javascript
amount: parsedBaseAmount,        // wallet credit in USD (server-derived)
netAmount: parsedBaseAmount,
currency: 'USD',                 // wallet currency, not gateway currency
```

And in line 240, pass `feeBreakdown.chargeNative` (INR rupees) to `createPhonePeTransaction`, not `parsedAmount` (USD). Update computeFees PhonePe branch to set `chargeNative = chargeUSD * inrRate`.

**FIX 5 (Vector E) — Lock down createPendingTransaction:**

File: `src/api/transaction/controllers/transaction.js:774-825` — replace handler to refuse client-supplied amount/gateway/walletId and only allow idempotent reads:
```javascript
async createPendingTransaction(ctx) {
  try {
    const { gatewayTransactionId } = ctx.request.body;
    const userId = ctx.state?.user?.id;
    if (!userId) return ctx.unauthorized();
    if (!gatewayTransactionId) return ctx.badRequest('gatewayTransactionId required');
    const existing = await strapi.db.query('api::transaction.transaction').findOne({
      where: { gatewayTransactionId, users_permissions_user: userId }
    });
    if (!existing) {
      strapi.log.warn(`[PENDING] no existing row for gatewayTransactionId=${gatewayTransactionId} user=${userId} — refusing client-planted transaction`);
      return ctx.notFound('No pending transaction. Use POST /api/transactions/payment.');
    }
    return { data: { transaction: existing } };
  } catch (error) {
    strapi.log.error('createPendingTransaction error:', error);
    return ctx.badRequest(error.message);
  }
}
```

Alternative: remove route entirely if no production caller (verify via 30-day API log audit first).

**Regression tests (full M11 suite required):**
1. Vector A: POST /payment with `currency:'INR',gateway:'stripe'` → 400, no Stripe call, no DB row.
2. Vector A: same with `currency:'EUR',gateway:'paypal'` → 400.
3. Vector A: legitimate `gateway:'razorpay'` (no currency) → 200, charges INR.
4. Vector B: createOrder captured by nock, `JSON.parse(custom_id).expectedChargeCents === 10000`.
5. Vector B: createOrder without expectedChargeCents in metadata → throws.
6. Vector B: webhook with mismatched capture amount → wallet unchanged + failed tx with metadata.error='amount_mismatch'.
7. Vector C: covered by C9 tests.
8. Vector D: PhonePe callback with mismatched amount → wallet unchanged, failed tx.
9. Vector D: legitimate callback → wallet credited transaction.amount (USD), NOT PhonePe rupee amount.
10. Vector E: POST /pending with `amount:99999,gatewayTransactionId:'fake'` → 404.
11. Vector E: POST /pending with valid existing gatewayTransactionId → 200, amount NOT replaced.
12. Happy path: $100 deposit via each of 4 gateways succeeds end-to-end, wallet credited exactly $100.
13. Concurrency: 10 parallel signed Stripe webhooks for same PI → exactly 1 credit.

**Production verification:**
1. Tail logs for `[PAYMENT M11] client sent currency=` (any client still sending non-USD).
2. Grep for `amount mismatch — REFUSING` across all webhook handlers (exploit attempts blocked).
3. DB spot-check: `SELECT id, gateway, amount, currency, metadata->>'expectedChargeCents' FROM transactions WHERE created_at > NOW() - INTERVAL '24h' AND transaction_status='success';` — all rows must have non-null expectedChargeCents.
4. PhonePe-specific: amount column must be USD value, expectedChargeCents must be INR-paise.
5. Manual attack replay from staging — assert wallet balance does NOT change.
6. Backfill check pre-deploy: `SELECT * FROM transactions WHERE transaction_status='pending' AND currency != 'USD' AND gateway IN ('stripe','paypal');` — mark failed before deploy.

**Bypass vectors (additional follow-ups):**
- BV-M11.1 (critical): `verifyRazorpayPayment` route (auth:false at line 187) lacks ownership + signature check — SEPARATE finding.
- BV-M11.2 (high): FX-rate drift between createPayment and webhook arrival — ±1 cent tolerance too tight for INR×83. Consider ±50 paise tolerance OR USD-equivalent ±$0.01 check.
- BV-M11.3 (high): controllers/transaction.js:110-128 test-mode branch (`!userId && NODE_ENV !== 'production'`) — anyone setting NODE_ENV via misconfigured staging can create payments crediting arbitrary wallets.
- BV-M11.4 (high): Stripe PI metadata client-side mutation — verify Stripe SDK update permissions for client-confirmable updates.
- BV-M11.5 (critical): PayPal webhook signature verification BYPASSED in sandbox (paypal.js:201-209) — confirm no production env runs in sandbox.
- BV-M11.6 (medium): Currency input fuzzing — lowercase, whitespace, unicode lookalikes ('ＩＮＲ'). computeFees must use strict ASCII uppercase equality.
- BV-M11.7 (high): Stripe-side currency at controller line 204 — must pass `feeBreakdown.chargeCurrency`, NOT body `currency`. Regression test must verify Stripe PI created with currency='usd'.
- BV-M11.8 (medium): In-flight orders created pre-fix-deploy may lack expectedChargeCents — set grace env vars to deploy+7d; monitor failed-tx rows for `error='missing_expected_amount'` to manually credit if legit.
- BV-M11.9 (high): Removing /webhook/:gateway might break Stripe production webhook config if pointed at legacy URL — UPDATE Stripe dashboard URL FIRST, then deploy.
- BV-M11.10 (medium): /api/transactions/pending removal might break partner integrations — check 30-day API logs first.

---

## Implementation Priority Order

Ship in this order to maximize harm reduction per unit of effort:

### Wave 1 (P0 — ship immediately, all small effort, no schema changes)

1. **C10 — Rotate ExchangeRate-API key + remove fallback** (effort: S, 30 min code + ops). Pure secret leak; rotate at provider, then code edit. ZERO production impact.

2. **C5 — Delete fix-earnings route + handler + migration** (effort: S). Pure deletion; no callers exist. Migration purges DB permission to prevent re-grant.

3. **C9 — Delete generic webhook routes + handler** (effort: S). Pure deletion; no callers (grep-verified). Closes both no-signature PayPal vector AND M11 Vector C in one move.

4. **C4 — Add admin gate to manual-update-razorpay route** (effort: S for route config only). EDIT 1 alone (route gate) closes the critical authz hole. EDIT 2 (handler hardening) can ship separately. **Do NOT roll back EDIT 1.**

### Wave 2 (P0 — ship within 24h)

5. **C3 — Replace verifyPayPalPayment with server-authoritative version** (effort: M). Single controller method rewrite; align dedup key with webhook on capture.id; add wallet-row lock. **Follow-up: add partial unique index migration.**

### Wave 3 (P1 — ship within 72h, sequenced sub-rollout)

6. **M11_BYPASSES — sequenced 5-vector rollout** (effort: M-L). Order:
   - **Vector A first** (computeFees currency pin) — closes the master exploit affecting all gateways. Add `currency` whitelist throw in computeFees + controller refactor + stripe-service.js whitelist restriction.
   - **Vector B** (PayPal custom_id + expectedChargeCents required) — closes PayPal-specific M11 disable. Sets `PAYPAL_M11_FIX_DEPLOY_TS` env var to deploy timestamp.
   - **Vector D** (PhonePe webhook M11 + USD/INR fix) — pre-existing baseline breakage. Backfill check first.
   - **Vector E** (createPendingTransaction lockdown) — verify no partner integrations first via API log audit.
   - **Vector C** — already shipped in C9 (Wave 1).

### Follow-up findings (P2 — separate audit cycles)

- BV-C3.1 / BV-C4.1 / BV-M11.1: Audit `verifyRazorpayPayment`, `verifyStripePayment`, `verifyPhonePePayment` for the same body-walletId-trust pattern.
- BV-C5.1 / BV-C5.2: Audit `addPromoFunds`, `addMainFunds`, all `scripts/fix-*.js` for ungated balance-mutation primitives.
- BV-C10.2: Repo-wide grep for `process.env.*_KEY.*||` patterns + add gitleaks pre-commit hook.
- BV-M11.3: Test-mode `NODE_ENV !== 'production'` branch in createPayment — restrict or remove.
- BV-M11.5: Audit PayPal signature verification behavior across environments.
- BV-C9.5: Add DB UNIQUE constraint on `(gateway, gatewayTransactionId)` with `transaction_status='success'` filter across ALL gateways.

---

## Disagreements Worth Noting

- **C5 verdict split (2 confirmed_real, 1 partial):** QA #3 marked partial because the May 2026 migration currently blocks the 'authenticated' role from calling fix-earnings. All 3 reviewers agree the code-level vulnerability (non-idempotent balance addition + missing route gate) is real and the recommended fix (delete) is correct. The 'partial' verdict only reflects current exploitability for non-admins, not the underlying bug.

- **C4 handler hardening scope:** Reviewers disagreed on whether EDIT 2 (Razorpay API verification + amount cross-check) should ship in the same PR as EDIT 1 (route gate). Recommendation: ship EDIT 1 alone immediately (closes critical authz hole); ship EDIT 2 in a follow-up PR with its own test suite. EDIT 1 alone reduces blast radius from "any user" to "admin pool only" which is sufficient to stop active exploitation.

- **M11 PhonePe behavior:** Reviewers diverged on whether PhonePe's current USD/INR confusion is a pre-existing baseline bug or part of the M11 family. Synthesizer call: treat as part of Vector D (it's a money-flow correctness bug that the M11 hardening should have caught). Fix in the same wave.

- **C9 stub vs delete:** Senior Dev #4 and Security Eng #4 disagreed on whether to delete the route entirely or keep a 410 Gone stub for telemetry. Synthesizer call: keep stub (telemetry value is high; 410 cost is negligible). The implementer should pick one and document.
