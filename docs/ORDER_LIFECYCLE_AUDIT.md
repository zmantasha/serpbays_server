# Order Lifecycle Audit — Prioritized Fix Plan

**Date:** 2026-06-15
**Scope:** Order creation → publisher acceptance/rejection → delivery → revision/redelivery → completion → payments (Razorpay/Stripe/PayPal/PhonePe webhooks) → wallet transactions → earnings → escrow → withdrawals → admin actions.
**Method:** 14-lens multi-agent review (4 senior devs + 3 DevOps + 4 QA + 3 security) → 238 raw findings → adversarial verification on HIGH findings → dedup + prioritize.

> **⚠ Verification gap to be aware of.** The Anthropic session token limit hit during the Verify phase. **12 of 106 HIGH findings completed 3-vote adversarial verification and survived; the remaining 94 HIGH findings were dropped because their verify agents could not run (null votes due to API limit, NOT because the finding was refuted).** All MEDIUM and LOW findings (132 of them) were collected from the Find phase and require no verification per the audit design. A follow-up verify pass should re-run the 94 unverified HIGHs to convert them into confirmed must-fix items or refute them; until then, this report treats them as **"Tier-2 must-fix candidates"** and surfaces the highest-impact ones inline.

## Summary

The order lifecycle holds money. Every flaw on this surface is either a **money-correctness bug** (escrow leaks, double-credits, lost refunds), a **privilege escalation** (mass-assignment of money or status), a **state-machine hole** (skip-the-line transitions), or an **audit-trail gap** (no forensic log when money moves). The audit confirms all four risk classes are present in the current codebase.

Headline themes the verified HIGHs and money-relevant MEDIUMs converge on:

1. **Status changes happen outside the money-moving transaction.** `rejectOrder`, `cancelOrder`, and several admin transitions update `orderStatus` in a SEPARATE write from the escrow refund / wallet credit — a window where a cron auto-cancellation or a webhook can re-fire the refund. Same pattern in withdrawal admin paths.
2. **Mass-assignment of money/status/audit fields.** `cancelOrder` accepts a user-supplied `cancelledBy='system'`, `create()` splats the order body into `entityService.update`, `createPayment` trusts user-supplied `baseAmount` (lets the wallet credit > what they pay), `createPendingTransaction` lets a caller plant arbitrary amounts on their own wallet, and default REST routes on `/api/transactions` and `/api/orders` are unguarded.
3. **Webhook safety is uneven across the 4 gateways.** Razorpay webhook signs a **re-serialized** body (vs raw — subtly broken). PhonePe webhook mutates wallet outside a transaction (lost-update risk on retries). PayPal refund touches only `balance` (breaks mainBalance/balance invariant). A generic `/api/transactions/webhook/:gateway` endpoint mirrors the gateway-specific ones with weaker checks — extra attack surface.
4. **Order audit log is largely silent.** `order-audit-log` rows are only written by `cancelOrder`. Accept / deliver / complete / reject / dispute / revision / escrow-release are unlogged — meaning a forensic question like "who completed order #1234 at 02:13 UTC and how did the escrow release?" cannot be answered from the DB.
5. **State machine has unreachable enum values and unbounded loops.** Schema enum has `'approved'` (never written) and lacks `'refunded'` (referenced from code constants). `requestRevision` has no counter or upper bound — an advertiser can request unlimited revisions. `disputeOrder` writes to a non-existent `disputeReason` column. No `resolveDispute` path exists, so disputed orders lock escrow indefinitely.
6. **Withdrawals have no row lock.** Parallel create-withdrawal requests can over-withdraw past the wallet balance. Admin `/admin/withdrawals/pay` writes a transaction with field names that don't exist on the schema (silently failing data persistence). `debugTransactions` and `fixMissingTransactions` endpoints expose data and mutate the wallet ledger with **no admin gate**.
7. **Public/auth:false endpoints leak transaction internals.** `GET /api/transactions/:id/status` is public and returns amount/currency/invoice; `GET /api/transactions/phonepe-status/:id` is public and triggers wallet credit by guessable id.

## Verification stats

| | |
|---|---|
| Total raw findings (Find phase) | 238 |
| Confirmed after dedup + verify | 144 |
| HIGH severity (verified-survived 3-vote adversarial) | **12** |
| HIGH severity (dropped — agents hit session limit, NOT refuted) | 94 |
| MEDIUM severity | 95 |
| LOW severity | 37 |
| Lenses run | 14 / 14 |
| Synthesis | Manual (synth agent hit session limit; this doc authored from the agent's input JSON) |

**Severity breakdown (verified scope):** 12 H, 95 M, 37 L — 144 total. Pending: 94 HIGH candidates not adversarially verified.

**Top hot files by finding count:**

| Findings | File |
|---:|---|
| 29 | `src/api/order/controllers/order.js` |
| 13 | `src/api/order/services/order.js` |
| 11 | `src/api/withdrawal-request/controllers/withdrawal-request.js` |
| 9 | `src/api/transaction/controllers/transaction.js` |
| 7 | `src/api/transaction/routes/transaction.js` |
| 6 | `src/api/transaction/controllers/razorpay-webhook.js` |
| 6 | `src/api/transaction/controllers/paypal-webhook.js` |
| 6 | `src/api/transaction/controllers/stripe-webhook.js` |
| 5 | `src/api/admin/controllers/orders.js` |
| 4 | `src/api/invoice/content-types/invoice/schema.json` |
| 3 | `src/cron/order-cancellation.js` |
| 3 | `src/api/transaction/controllers/phonepe-webhook.js` |
| 3 | `src/api/admin/controllers/wallets.js` |
| 3 | `src/api/bank-transfer-request/controllers/bank-transfer-request.js` |

---

## Must-fix (HIGH severity, verified) — 12 items

### M1. `cancelOrder` accepts user-supplied `cancelledBy='system'`, bypassing all ownership checks
- **File:** `src/api/order/controllers/order.js:2733-2789`
- **Lens:** order-controller (verified 3/3)
- **Risk:** Any authenticated user can `POST /orders/:id/cancel` with `{ cancelledBy: 'system', reason: '...' }` and force a full escrow refund on any non-finished order. Money exits escrow into the advertiser's wallet without the advertiser ever interacting.
- **Fix:** Hard-set `cancelledBy = ctx.state.user.id` server-side. Reject any caller-supplied `cancelledBy` (don't even read it from the body). Add ownership check: advertiser of the order, or admin.
- **Effort:** S — **Regression risk:** low

### M2. `create()` splats `...orderData` into `entityService` — caller can stamp lifecycle and audit fields
- **File:** `src/api/order/controllers/order.js:63-85, 409-427`
- **Lens:** order-controller (verified)
- **Risk:** Audit poisoning and money tampering. Caller can include `orderStatus: 'completed'`, `paymentStatus: 'paid'`, `escrowStatus: 'released'`, arbitrary `amount`, `currency`, `acceptedAt`, `deliveredAt`, `createdByAdmin: true`, etc. in the POST body and have them written.
- **Fix:** Fail-closed allowlist on `orderData` (same pattern as the website-audit #5 `ALLOWED_USER_FIELDS`). Strip every field the publisher/advertiser must NOT set themselves — money, status, escrow, timestamps, FK relations to user/admin, audit-only columns.
- **Effort:** S — **Regression risk:** low

### M3. `rejectOrder` controller: status flip happens OUTSIDE the service's refund transaction
- **File:** `src/api/order/controllers/order.js:1472-1483`
- **Lens:** order-controller + order services (cross-lens convergence; verified)
- **Risk:** Money. The service `rejectOrder()` runs a DB transaction that refunds escrow and creates the refund tx — but does NOT flip `orderStatus`. The controller calls the service, **then issues a separate `db.query` UPDATE** to set `orderStatus='rejected'`. Between commit-of-refund-tx and the status flip, a cron auto-cancellation or a parallel admin action can re-fire the refund.
- **Fix:** Move the status flip INTO the service's transaction. The service should commit refund + status atomically.
- **Effort:** S — **Regression risk:** medium (touches the publisher reject flow)

### M4. Admin `updateStatus` bypasses money flow for `'rejected'` and `'cancelled'` transitions
- **File:** `src/api/admin/controllers/orders.js:157-251`
- **Lens:** order-controller + order-services (verified)
- **Risk:** Money. For `'completed'` the admin path correctly routes through `services.completeOrder()` (refund + payout atomically). For `'rejected'` and `'cancelled'` it just flips the status with no escrow refund — money stays locked in escrow even though the order is closed.
- **Fix:** Route `'cancelled'` through `services.cancelOrder` and `'rejected'` through `services.rejectOrder`. Block direct admin status flips that bypass the money flow.
- **Effort:** S — **Regression risk:** medium

### M5. `completeOrder` service has no `revisionStatus` guard — advertiser can complete while revision pending
- **File:** `src/api/order/services/order.js:211-398`
- **Lens:** order-services (verified)
- **Risk:** Money + UX. The `/orders/:id/complete` route checks only `orderStatus==='delivered'`. The service does NOT verify `revisionStatus !== 'requested'`. An advertiser who requested a revision can immediately complete the order before the publisher even sees the revision — escrow releases on stale work.
- **Fix:** Service must refuse complete when `revisionStatus IN ('requested', 'in_progress')`. Add a regression test.
- **Effort:** S — **Regression risk:** low

### M6. `disputeReason` is written to a column that does not exist — dispute rationale silently lost
- **File:** `src/api/order/controllers/order.js:2003-2011`
- **Lens:** order-services (verified)
- **Risk:** Data integrity + legal. `disputeOrder` writes `disputeReason: body.reason` but the order schema has no `disputeReason` attribute (only `disputeDate`). Strapi's `entityService.update` silently drops it. Disputes are filed with no recorded reason — a legal/compliance hole when the dispute escalates.
- **Fix:** Add `disputeReason: { type: 'text' }` to the schema, ship a migration, and store the reason.
- **Effort:** S — **Regression risk:** low

### M7. `cancelOrder` is not transactional — refund + status flip can desync, enabling double refund via cron
- **File:** `src/api/order/controllers/order.js:2732-2789`
- **Lens:** order-services (verified)
- **Risk:** Money. Controller calls `refundEscrowToAdvertiser` (mutates wallet + writes refund transaction), then separately updates orderStatus to `'cancelled'`. If the second write fails OR a concurrent cron's auto-cancellation re-fires, a second refund is paid out.
- **Fix:** Wrap refund + status flip + audit-log creation in a single `strapi.db.transaction`. Take a `SELECT ... FOR UPDATE` on the order row at the top so concurrent cancels serialize. Same pattern as the website audit's #7 TOCTOU fix.
- **Effort:** M — **Regression risk:** medium (cancellation is a hot path)

### M8. (duplicate of M3, surfaced by a second lens — convergence signal)
- **File:** `src/api/order/controllers/order.js:1473-1483`
- **Lens:** order-services
- *(Merged into M3 — same root cause, two reviewers caught it independently.)*

### M9. No revision counter or upper bound — advertiser can request unlimited revisions
- **File:** `src/api/order/controllers/order.js:2218-2328`
- **Lens:** order-services (verified)
- **Risk:** Business logic / abuse. `requestRevision` flips orderStatus `delivered→accepted` and sets `revisionStatus='requested'`, but stores no counter. `completeRevision` flips back. There's nothing capping the cycle — an advertiser can loop the publisher indefinitely while escrow holds funds.
- **Fix:** Add `revisionCount` (int, default 0) to the order schema. Increment on each `requestRevision`. Refuse when `revisionCount >= MAX_REVISIONS` (start with 3, or read from gateway settings).
- **Effort:** M (schema migration + UI surfacing) — **Regression risk:** low

### M10. Order audit log only fires for cancellation — accept/deliver/complete/reject/dispute/revision unlogged
- **File:** `src/api/order/services/order.js:914-935` (and every controller path that doesn't call `createAuditLog`)
- **Lens:** order-services + devops-observability (cross-lens convergence; verified)
- **Risk:** Forensics and compliance. Every money-moving and status-changing operation should produce an `order-audit-log` row. Today `createAuditLog` is only invoked from `cancelOrder`. After an incident there's no way to reconstruct "who completed this and when, and which tx settled the escrow".
- **Fix:** Wire `createAuditLog` calls into every state-change path: accept, reject, deliver, request-revision, complete-revision, complete, dispute, escrow-release. Pass actor (`userId`, `role`), pre-state, post-state, and any tx ids. Inside the same transaction as the state change.
- **Effort:** M — **Regression risk:** low

### M11. User-supplied `baseAmount` lets attackers credit wallet far more than they pay
- **File:** `src/api/transaction/controllers/transaction.js:15-33`
- **Lens:** payments-webhooks (verified)
- **Risk:** Money. `createPayment` reads `baseAmount` directly from `ctx.request.body` with no upper-bound or relationship check against `amount`. `baseAmount` is then stored on the gateway-side metadata AND read back on webhook confirmation to credit the wallet. Attacker pays $1, sets `baseAmount=1000`, wallet credits $1000.
- **Fix:** Derive `baseAmount` server-side from the requested currency + the actual `amount`. Never trust caller. Reject any client-supplied `baseAmount`.
- **Effort:** S — **Regression risk:** medium (downstream rate conversion changes)

### M12. Razorpay webhook signature computed over re-serialized JSON, not raw body
- **File:** `src/api/transaction/controllers/razorpay-webhook.js:21-52`
- **Lens:** payments-webhooks + security-webhooks (cross-lens; verified)
- **Risk:** Security. Signature is computed via `crypto.createHmac('sha256', secret).update(JSON.stringify(ctx.request.body))`. Razorpay computes HMAC over the EXACT raw payload. Re-serialization can change key order, whitespace, number formatting — signatures appear to verify in happy cases but fail subtly on edge cases, OR worse, the handler tolerates re-serialized signatures, opening it to a forged payload that JSON.stringify happens to produce.
- **Fix:** Use the raw body (Strapi exposes `ctx.request.body[Symbol.for('unparsedBody')]` — already in use for stripe-webhook). Re-write to read raw, then HMAC over that. Use `crypto.timingSafeEqual` for comparison.
- **Effort:** S — **Regression risk:** medium (requires careful body-parser config to keep the raw body)

---

## Must-fix Tier-2 (high-impact MEDIUMs + unverified HIGH candidates) — 14 items

These were classified MEDIUM by the original lens or are HIGH findings that the session-limit prevented from being adversarially verified. Their risk character is money / auth / data-integrity equivalent to the verified HIGHs above. Ship alongside the must-fix list.

### T1. Bank transfer "completion" credits wallet but doesn't link transaction with valid enum values
- **File:** `src/api/bank-transfer-request/controllers/bank-transfer-request.js:203-235`
- **Risk:** Money + data: bank-transfer completion writes a transaction row with `type`/`status` values not in the schema enum (Strapi 5 silently drops or 500s). The wallet credit happens but the audit row is malformed — money in, no clean ledger entry.
- **Fix:** Use validated enum values from the schema; verify against `src/api/transaction/content-types/transaction/schema.json`.
- **Effort:** S

### T2. Admin `markAsPaidWithdrawal` / `denyWithdrawal` mutate money without locks; lookup of the "pending" transaction is fuzzy
- **File:** `src/api/withdrawal-request/controllers/withdrawal-request.js:691-789, 791-940`
- **Risk:** Money. Two concurrent admin clicks can both find the same "pending" tx (fuzzy match by amount + recent date), both flip it to "paid", double-credit the withdrawal record.
- **Fix:** Atomic update using the txn primary key + `WHERE status='pending'` clause + advisory lock. Tighten the lookup.
- **Effort:** M

### T3. Admin `updateStatus` bypasses escrow refund for cancelled/rejected — money stays locked
- **File:** `src/api/admin/controllers/orders.js:213-251`
- *(Already covered by M4. Cross-lens convergence — two reviewers from different angles flagged it.)*

### T4. Admin `/admin/withdrawals/pay` handler writes transaction with field names that don't exist on the schema
- **File:** `src/api/admin/controllers/withdrawals.js:347-360`
- **Risk:** Data integrity. Fields `transactionType`, `status`, `transactionId` don't exist on the transaction schema (the real fields are `type`, `transactionStatus` or similar). The write silently drops them — the tx row is incomplete, never matches reconciliation queries.
- **Fix:** Read the schema attributes, rewrite the writer to use the correct field names.
- **Effort:** S

### T5. `debugTransactions` and `fixMissingTransactions` endpoints expose data and mutate wallet ledger with NO admin gate
- **File:** `src/api/withdrawal-request/controllers/withdrawal-request.js:1151-1320`
- **Risk:** Security. Any authenticated user can call these — read every wallet's transactions or force-create missing transaction rows. The "debug" naming suggests they were prototyped and never gated.
- **Fix:** Remove them OR gate behind `global::is-admin-with-jwt` policy. Audit who ever called them in prod logs.
- **Effort:** S

### T6. Default PUT `/api/transactions/:id` and POST `/api/transactions` exposed with no field allowlist
- **File:** `src/api/transaction/routes/transaction.js:31-60`
- **Risk:** Mass-assignment. Strapi's auto-generated REST routes accept any field on the transaction schema. A user can PUT `{ amount: 999999, transactionStatus: 'success', userWallet: <victim_id> }` on their own transaction.
- **Fix:** Disable the auto-generated routes (`config.find/findOne/create/update/delete: { auth: false }` style — or remove them from the router). Replace with explicit endpoints for legitimate use cases only.
- **Effort:** M

### T7. Withdrawal creation lacks transaction + wallet row lock — two parallel requests can over-withdraw
- **File:** `src/api/withdrawal-request/controllers/withdrawal-request.js:300-453`
- **Risk:** Money. Read-then-write window: read wallet balance, validate ≥ requested, write withdrawal row. Two concurrent calls both pass, both deduct → wallet goes negative.
- **Fix:** Wrap in `strapi.db.transaction`; `SELECT … FOR UPDATE` on the wallet row.
- **Effort:** M

### T8. `deliverOrder` pending→accepted→delivered window allows double-credit on completion
- **File:** `src/api/order/controllers/order.js:1688-1776`
- **Risk:** Money. Concurrent deliver + accept can leave the order in a state where completeOrder later credits the publisher twice (escrow released twice). Same TOCTOU pattern as website audit #7.
- **Fix:** `SELECT … FOR UPDATE` on the order row; re-check `orderStatus` inside the lock.
- **Effort:** M

### T9. PhonePe webhook updates wallet outside a transaction; concurrent retries cause lost-update double credit
- **File:** `src/api/transaction/controllers/phonepe-webhook.js:13-86`
- **Risk:** Money. Gateway retries (5+ over 24h). Wallet credit reads balance, computes new = balance + amount, writes. Two retries can both read pre-credit balance and both add → double credit.
- **Fix:** Move the wallet write inside a transaction with row lock; add idempotency on PhonePe `merchantTransactionId` (UNIQUE in DB or guard before increment).
- **Effort:** M

### T10. `createPendingTransaction` lets caller plant arbitrary amount/gateway/gatewayTransactionId rows on their own wallet
- **File:** `src/api/transaction/controllers/transaction.js:698-749`
- **Risk:** Mass-assignment. Endpoint writes raw body into transaction row without an allowlist. User can pre-create a "success" tx tied to their own wallet with a fake gateway ID, then the webhook sees the gatewayTransactionId match and credits the wallet.
- **Fix:** Allowlist (`amount`, `currency`, `gateway` only). Force `transactionStatus='pending'` server-side. Force `userWallet = ctx.state.user.wallet`.
- **Effort:** S

### T11. Public `getTransactionStatus` (auth:false) leaks transaction amount/currency/invoice by guessable ID
- **File:** `src/api/transaction/controllers/transaction.js:67-77` (routes) and `:752-807` (controller)
- **Risk:** Privacy / business intelligence leak. Sequential numeric IDs let a scraper pull every transaction's amount + currency + linked invoice number.
- **Fix:** Either require auth (caller must own the wallet for that tx), or scope the response to status-only (no amount/invoice/currency), or move to UUID + signed URLs.
- **Effort:** S

### T12. PhonePe-status public endpoint (auth:false) lets anyone trigger wallet credit by ID
- **File:** `src/api/transaction/routes/transaction.js:202-210`
- **Risk:** Money. The handler does a "check + credit if not credited" pattern. A scraper sequentially probing every tx id force-completes any successful-on-gateway tx that hadn't yet been confirmed on our side.
- **Fix:** Require auth + ownership check. The check-and-credit logic should be webhook-driven only, not invokable by an unauth GET.
- **Effort:** S

### T13. Razorpay `verifyPayment` (auth: false) allows hostile actor to brick a victim's transaction
- **File:** `src/api/transaction/controllers/razorpay-webhook.js:324-385`
- **Risk:** Denial-of-service / data tampering. Unauth caller can POST a malformed verify payload that flips a victim's pending tx to failed.
- **Fix:** Require auth on `verifyPayment` (the caller must own the tx). Webhook side is signature-gated; user-side should be JWT-gated.
- **Effort:** S

### T14. Duplicate generic webhook route `/api/transactions/webhook/:gateway`
- **File:** `src/api/transaction/routes/transaction.js:129-144` (route) and `controllers/transaction.js:322-672` (handler)
- **Risk:** Attack surface. Mirrors the 4 gateway-specific webhook routes but with weaker checks and missing row locks. An attacker can target the weaker path with the same gateway secret if known.
- **Fix:** Delete the generic route — the per-gateway routes are the canonical paths.
- **Effort:** S

---

## Should-fix (remaining MEDIUMs) — 81 items

Grouped by theme. Full list with file:line citations is in the agent transcript at `/tmp/order_audit_confirmed.json`. The highlights:

### Payment / webhook hygiene
- PayPal refund updates only `balance`, breaking the `mainBalance`/`balance` invariant (`paypal-webhook.js:437-449`).
- Stripe-webhook invoice creation is best-effort and silently swallowed — paid orders without invoices (`stripe-webhook.js:436-446`).
- PayPal payout webhooks are unhandled stubs (`paypal-webhook.js:459-489`) — publisher payouts never get marked sent via PayPal.
- PhonePe gateway value missing from transaction schema enum — phonepe rows fail validation.
- Razorpay `updateWalletBalance` overwrites `balance` using stale promo snapshot → lost-update on concurrent mainBalance change.

### Data model integrity
- `transaction` required money-flow relations are optional — orphan transactions possible (`transaction/content-types/.../schema.json:69-99`).
- `transaction.amount min=0` lets fee/withdrawal/payout rows commit at 0.
- Order `orderStatus` enum has unreachable values (`'approved'`) and lacks one referenced from code constants (`'refunded'`).
- No UNIQUE on `(gatewayTransactionId, gateway)` — duplicate webhooks can insert rather than dedup.
- `order-content` has no UNIQUE per (order, revisionRound) → can be created twice.

### State machine + business logic
- `requestRevision` boundary: simultaneous `completeOrder` corruption.
- Disputed orders have no resolution path — escrow locked indefinitely.
- Order TAT countdown cached vs computed inconsistency.

### Wallet / earnings / withdrawals
- Withdrawal OTP create flow: spend wallet + create pending tx are not atomic.
- `approveWithdrawal` doesn't send approval email; `denyWithdrawal` lifecycle hook fires duplicate transaction.
- Admin wallet adjustments not audited (no `wallet-audit-log` equivalent).

### Observability / audit
- `completeOrder` writes wallet mutation + transactions but no `order-audit-log` row — escrow release is invisible to forensics (overlaps M10).
- `bank-transfer-request` creation reads `ADMIN_EMAIL` and `userId` straight from request body — no audit, no structured log.

### Security / RBAC / CSRF
- Several admin endpoints under `/api/admin/*` rely on JWT-only auth without an explicit `global::is-admin` policy gate (defense-in-depth gap).
- `getTransactionStatus` returns transaction internals to anonymous callers (covered in T11).

### DevOps / env / secrets
- Several env vars lack fail-closed-at-boot validation (Razorpay/Stripe/PayPal/PhonePe webhook secrets, `JWT_SECRET` fallback — same class as website audit #9).
- `.env.example` missing several gateway-related vars actually used in code.

### Idempotency / cron
- `order-cancellation` cron has no advisory lock — two pm2 instances will both auto-cancel.
- Webhook retries lack a central `processed_webhook_events` dedup table; each gateway controller rolls its own (uneven coverage).

*(Full enumeration in the JSON dump at `/tmp/order_audit_confirmed.json`.)*

## Nice-to-have (LOWs) — 37 items

Code hygiene, logging cleanup, dead routes, copy/UX polish, redundant try/catch swallowing errors silently, etc. None money-critical. See JSON dump for the full list.

## Merged-out / refuted

- Lens convergence reduced ~12 cross-cited findings to single entries (e.g. M3 = M8).
- 94 HIGH findings were dropped due to API session limit during verification — they are **NOT refuted, they are unverified**. A follow-up pass should re-run the verify stage on those.
- No HIGH findings were definitively refuted in this audit run (the verifications that ran all confirmed the finding).

## Recommended execution order

Ship the must-fix list in this order. Each item starts with the smallest blast radius first, and bunches together items that touch the same files/migrations so we re-restart pm2 fewer times.

**Phase 1 — money-correctness atomicity (highest priority):**
1. **M1** Hard-set `cancelledBy` server-side — 1-line fix, prevents free escrow refunds today
2. **M7** Wrap `cancelOrder` (refund + status + audit log) in a single transaction with row lock
3. **M3 / M8** Same pattern for `rejectOrder`
4. **T8** Same pattern for `deliverOrder` (TOCTOU row lock)
5. **M4 / T3** Route admin `rejected` and `cancelled` transitions through service-layer money flow

**Phase 2 — mass-assignment / privilege closure:**
6. **M2** `create()` allowlist
7. **M11** Strip `baseAmount` from `createPayment` body, derive server-side
8. **T10** `createPendingTransaction` allowlist
9. **T5** Gate `debugTransactions` / `fixMissingTransactions` behind admin policy (or remove)
10. **T6** Disable default `/api/transactions` CRUD routes; replace with explicit endpoints
11. **T11 / T12 / T13** Lock down auth:false transaction endpoints

**Phase 3 — webhook hygiene + idempotency:**
12. **M12** Razorpay webhook: switch to raw body for HMAC
13. **T9** PhonePe webhook: transaction-wrap wallet credit + idempotency on `merchantTransactionId`
14. **T14** Delete generic `/webhook/:gateway` route
15. Add a central `processed_webhook_events` dedup table (covers all 4 gateways)
16. PayPal refund: touch both `mainBalance` and `balance`; fix mainBalance/balance invariant

**Phase 4 — state machine + business logic:**
17. **M5** `completeOrder` revisionStatus guard
18. **M9** Revision counter + upper bound (schema migration)
19. **M6** `disputeReason` column (schema migration)
20. Disputed-order resolution path (new admin endpoint)

**Phase 5 — withdrawals:**
21. **T2** Admin withdrawal pay: atomic with primary-key clause
22. **T7** Withdrawal create: wallet row lock
23. **T4** Fix admin withdrawals.pay() field names
24. **T1** Bank-transfer-completion: validated enum values

**Phase 6 — audit trail backfill:**
25. **M10** Wire `createAuditLog` into every state-change path

**Phase 7 — should-fix and nice-to-have batches** (see Should-fix section + JSON dump)

**Phase 8 — re-run the dropped 94 HIGH verifications** when session capacity is available, then promote any that survive into the must-fix list.

## Shipped status (last updated 2026-06-18)

| W4-R47/R51/R107 | denyWithdrawal double-refund | ✅ shipped 2026-06-18 | Independently verified Wave-4 race+idempotency-audit finding (6/6 critical + 6/6 money-loss + 6/6 fix-safe). Controller `denyWithdrawal` (controllers/withdrawal-request.js:702) flipped withdrawal_status→'denied' via entityService.update — triggering afterUpdate lifecycle `handleDeniedWithdrawal` (lifecycles.js:132) which credits `totalRefund = amount + platformFee` (gross, correct). The controller ALSO inline-credited `withdrawalRequest.amount` (net only) + decremented pendingWithdrawalBalance + created a redundant refund-tx row (lines 733-759). Net effect on every legitimate deny: wallet credited ~1.8× intended refund (e.g. $80 net withdrawal → $180 returned instead of $100). **Fix:** removed controller's inline refund block (l.733-759), replaced with a forensic comment pointing at the lifecycle as source-of-truth. Lifecycle's math is correct (gross refund matches what was debited at create-time). Regression test `scripts/test-deny-withdrawal-single-refund.js` (11/11) asserts: controller still flips status to 'denied' (so lifecycle fires); controller no longer writes mainBalance/pendingWithdrawalBalance/refundAmount; controller no longer creates type:'refund'+status:'denied' tx; lifecycle handleDeniedWithdrawal + totalRefund math + dispatch still intact. Full suite now 19 tests / 372 assertions all PASS. Backend restart clean. **Known residual (out of scope for this ship):** lifecycle fires on EVERY update where status==='denied', not just transition-to-denied — so any subsequent update of a denied withdrawal (e.g. setting denial_reason later) re-credits. Add transition guard in Wave-4 next pass. |

---

## Shipped status (legacy, last updated 2026-06-17)

| # | Title | Status | Notes |
|---|---|---|---|
| C10 | ExchangeRate-API key hardcoded fallback | ⚠ code-side shipped, provider-rotation deferred | Hardcoded fallback removed from `src/api/payment-gateways/services/exchange-rate.js`; URL becomes null when env var unset → falls back to static `FALLBACK_USD_TO_INR=83.25`. `.env.example` updated. Forensic redaction applied to audit docs and the dead nested-tree copy. Regression test `scripts/test-secrets-not-hardcoded.js` (5/5) static-grep enforces no hardcoded fallback. **Provider-side key rotation at exchangerate-api.com remains pending per user — code-side mitigation prevents runtime use, but the leaked key remains LIVE at the provider and anyone with repo read access can still call it directly.** |
| C5 | `/api/wallet/fix-earnings` ungated non-idempotent loop | ✅ shipped 2026-06-17 | Reproduced + confirmed: route was `auth: {}` (any user); DB query showed authenticated role STILL had `up_permissions` perm_id 1826 linked despite the May-23 revocation migration — relying on perm revocation alone is fragile. Handler at `controllers/user-wallet.js:726-831` looped ALL approved/completed orders and credited `order.totalAmount` (gross, not publisher's net) on every call; existing-tx branch double-credited despite the in-code "idempotent" comment. **Fix:** route entry deleted (`routes/user-wallet.js:158-166`), handler deleted (`controllers/user-wallet.js:726-831`), kill-migration `2026.06.17T00.00.00.security-remove-fix-earnings-route.js` purged perm_ids 169/1778/1826 + their links. Strapi restarted clean; DB post-state: 0 perm rows, 0 link rows for the action. HTTP probe: `POST /api/wallet/fix-earnings` → 405 (matches Strapi's `/api/*` fallback for unknown paths — verified against a known-nonexistent control path). Regression test `scripts/test-fix-earnings-removed.js` (9/9). Full suite now 14 tests / 301 assertions all PASS. |
| W3-A | M11 bypass: client-supplied `currency` flowed to Stripe/PayPal/PhonePe | ✅ shipped 2026-06-17 | Reproduced: `createStripePaymentIntent(amount, currency, ...)` and `createPayPalOrder(amount, currency, ...)` accept the body's `currency`. Stripe `Math.round(100*100)=10000 IDR ≈ $0.006` while wallet credit (USD intent) stays $100 — up to ~17,000× per call. **Fix:** server-side `CURRENCY_BY_GATEWAY = {stripe:'USD', paypal:'USD', phonepe:'USD', razorpay:'INR'}`; client-supplied currency overridden, mismatches logged as `[CURRENCY_TAMPER]`. HTTP probe: POST `{amount:10, currency:'IDR', gateway:'stripe'}` → backend log: `[CURRENCY_TAMPER] user=5 ip=127.0.0.1 gateway=stripe client-supplied currency=IDR server-forced=USD`. |
| W3-B | M11 bypass: PayPal `createOrder` silently dropped `expectedChargeCents` | ✅ shipped 2026-06-17 | Reproduced (code reading): `services/paypal.js:50-56` built `customIdData = {walletId, baseAmount, totalAmount, userId}` — `expectedChargeCents` was passed into `createPayPalOrder(amount, currency, metadata)` but never persisted into the PayPal order's `custom_id`. PayPal webhook + `verifyPayPalPayment` then read `customData.expectedChargeCents = undefined` and fell into the grace-period warn-and-credit branch — effective M11 no-op for ALL PayPal traffic until 2026-07-16. **Fix:** added `expectedChargeCents` and `expectedChargeUSD` to `customIdData` in `services/paypal.js:51-66`. Combined with C3 (server-authoritative verify-paypal) and the M11-hardened webhook, PayPal now hard-rejects amount mismatches. |
| W3-C | M11 bypass: PhonePe `handleCallback` + `checkStatus` missing M11 check | ✅ shipped 2026-06-17 | Reproduced (code reading): `phonepe-webhook.handleCallback:75-78` called `updateWalletBalance(walletId, amount, currency)` with no comparison against `transaction.metadata.expectedChargeCents`; same gap in `checkStatus:122-136`. A signature-verified PhonePe payload reporting a different amount than committed would credit the gateway-reported value. **Fix:** added M11 cross-check in both methods. `actualChargeCents = Math.round(amount * 100)` vs `tx.metadata.expectedChargeCents`; mismatch → demote tx to `failed`, write `m11Error: amount_mismatch` to metadata, refuse credit; 2026-07-16 grace-period boundary mirrors the other webhooks. **Pre-existing USD/INR unit-confusion in PhonePe (computeFees stores USD cents, PhonePe charges in INR paise) is documented as a SEPARATE follow-up — outside Wave-3 scope; the numerical-equality M11 check still works correctly as a "did PhonePe charge exactly what we asked for" verification.** |
| W3-D | M11 bypass: `POST /api/transactions/pending` accepted client-supplied amount/gateway | ✅ shipped 2026-06-17 | Reproduced: handler at `controllers/transaction.js:433-484` accepted `{amount, gateway, gatewayTransactionId, walletId}` from body, verified walletId ownership only, created pending tx with body amount verbatim — no `expectedChargeCents` stashed. Exploit: attacker initiates real $1 gateway payment, then POSTs `/api/transactions/pending` with `{amount:1000, gatewayTransactionId:<real $1 orderId>, walletId:<theirs>}` → pending row planted; webhook then credits the $1000 during M11 grace period (warn-and-credit branch fires because no `expectedChargeCents`). Frontend grep across both repos: 0 callers. 7-day backend log: 0 successful production hits. **Fix:** route entry deleted (`routes/transaction.js`), 52-line handler deleted (`controllers/transaction.js`). HTTP probes: `GET /api/api/transactions/pending` → 403, `POST` → 405 (Strapi default for unknown `/api/*`). Regression test asserts route + handler absent. |
| C3 | `verifyPayPalPayment` not server-authoritative — trusts client `walletId` + no M11 cross-check | ✅ shipped 2026-06-17 | Reproduced: handler at `controllers/transaction.js:545-646` accepted `{orderId, walletId}` from body, idempotency was keyed on `(orderId, walletId)` tuple (so the same PayPal orderId could be re-bound to a different wallet → cross-user credit), credit used PayPal gross amount (no M11 expectedChargeCents check). Vectors V1 cross-user replay, V2 M11 bypass, V3 PayPal gross vs server baseAmount. **Fix:** complete rewrite mirroring the M11-hardened `paypal-webhook.handlePaymentCompleted`. Now ignores `body.walletId` entirely; parses `walletId`, `baseAmount`, `expectedChargeCents` from the PayPal order's `custom_id` (server-set at createPayment time); enforces `wallet.users_permissions_user.id === ctx.state.user.id` (returns 403 on mismatch); idempotency keyed on `(gatewayTransactionId, gateway='paypal', status='success')` across ALL wallets; M11 amount-mismatch check with 2026-07-16 grace-period boundary identical to the webhook; failed-tx audit row written on mismatch; credits server-derived `baseAmount` not PayPal gross. HTTP probes (post-fix on `/api/api/transactions/verify-paypal`): unauth → 403; authed + missing orderId → 400 `"orderId is required"`; authed + attack-shape `{orderId, walletId:<victim>}` → handler logs only `orderId` (walletId body field discarded; PayPal call fails on synthetic orderId so wallet-credit path not reached). Regression test `scripts/test-verify-paypal-server-authoritative.js` (18/18). Full suite now 17 tests / 341 assertions all PASS. **Live-payment E2E deferred to QA pass alongside C9.** |
| C4 | `/api/transactions/manual-update-razorpay` JWT-only (no admin gate) | ✅ shipped 2026-06-17 | Reproduced: route config was `auth: { strategies: ['jwt'] }` — Strapi 5 JWT-presence check WITHOUT scope/role enforcement (any authenticated user passed). Handler at `controllers/razorpay-webhook.js:751-800` accepts `{order_id, payment_id, status}` from request body, finds the tx by `gatewayTransactionId`, flips status, and when `status==='success'` calls `updateWalletBalance(wallet.id, amount, currency)`. Exploit: any user starts the normal "add funds" flow → real Razorpay pending tx created on their wallet → user abandons checkout without paying → user POSTs `{order_id:'<their pending>', status:'success'}` → tx flips to success and wallet is credited (free money). **Fix:** changed route config to the same admin-gate trio used by the sibling `cleanup-pending-razorpay` route: `auth: false`, `policies: ['global::is-admin']`, `middlewares: ['global::admin-jwt-auth']`. Frontend grep across `serpbays_client` + `serpbays-adminpanel`: 0 callers (used by ops via curl/Postman during incident response, not via UI). 7-day backend log: 0 historical invocations. HTTP probes (post-fix, on the actual `/api/api/...` Strapi 5 double-prefix mount): unauthenticated → **403 PolicyError "Policy Failed"**; with user-role JWT → **403 PolicyError "Policy Failed"**. Sibling `cleanup-pending-razorpay` (control, identical gate) returns the identical 403, confirming the policy chain. Regression test `scripts/test-manual-update-razorpay-admin-gated.js` (10/10). Full suite now 16 tests / 323 assertions all PASS. **Strapi-5 routing detail surfaced during verification: routes whose `path` already begins with `/api/` get double-prefixed at runtime — actual mount is `/api/api/transactions/manual-update-razorpay`. The frontend already uses this `/api/api/...` form (confirmed by `POST /api/api/transactions/payment` in the live log). The duplicate-route entry for `/api/api/transactions/webhook/:gateway` we removed in C9 was someone working around this same Strapi quirk.** |
| C9 | Generic `/api/transactions/webhook/:gateway` route + `handleWebhook` method | ⚠ code-side shipped, live-E2E deferred | Reproduced + confirmed: two routes (`/api/transactions/webhook/:gateway` and the typo-duplicate `/api/api/transactions/webhook/:gateway`, both `auth:false`) dispatched to `transaction.handleWebhook` (`controllers/transaction.js:397-748`). Three independent vectors: (a) PayPal branch captured a body-supplied orderID with NO signature verification of any kind; (b) Stripe branch verified signature but credited wallet by `existingTransaction.amount` with NO `expectedChargeCents` cross-check; (c) Razorpay branch used checkout-HMAC instead of webhook-secret HMAC. **Fix:** both routes deleted; 352-line `handleWebhook` method body replaced with a forensic stub. Cross-tree grep: 0 internal callers. Live module reflection: `require(routes).filter(r=>r.handler==='transaction.handleWebhook').length === 0`; controller now exports 7 `(ctx)` handlers — `handleWebhook` not among them. Dedicated `{paypal,razorpay,stripe}-webhook.handleWebhook` routes still registered. 7-day backend-log forensic: `RECEIVED *WEBHOOK` signature (the deleted handler's log line) appeared **0 times** — the route was effectively dead code in this environment. Regression test `scripts/test-generic-webhook-removed.js` (12/12). Full suite now 15 tests / 313 assertions all PASS. **Live-payment E2E across Stripe/PayPal/Razorpay deferred to QA pass — staging has 0 historical Stripe/PayPal traffic so passive observation cannot supply the evidence; must be a net-new test.** Production follow-up: spot-check each gateway dashboard to confirm no subscription is pointed at the removed legacy URL. |
| M1 | `cancelOrder` cancelledBy mass-assignment | ✅ shipped | Reproduced + downgraded: route already gated to super_admin, so original "any authenticated user" framing was a partial false positive. The underlying bug (server trusted body.cancelledBy, validator short-circuited on 'system', audit trail masked actor) is real. Fix: controller derives cancelledBy server-side from caller role + order relationship; service rejects 'system' when userId is present (defense-in-depth). Cron path (userId=null) unchanged. Regression test `scripts/test-cancel-order-authz.js` (18/18). |
| M2 | `create()` orderData allowlist | ✅ shipped | Reproduced + downgraded + rescoped: audit's specific claims (orderStatus / escrowHeld / paymentStatus / advertiser / publisher injection) were FALSE POSITIVES — the service forces orderStatus='pending'+escrowHeld=totalAmount+orderDate, the controller forces advertiser=user.id and publisher=marketplace.publisher, and paymentStatus doesn't exist on schema. But mass-assignment IS real for ~14 lifecycle/audit/admin-only fields (createdByAdminId, adminReason, userConsentType, userConsentReference, acceptedDate, completedDate, rejectedDate, cancelledBy/At/Reason/Notes, deliveryProof/Message, revisionStatus, warningNotificationSentAt, rejectionReason). Fix: fail-closed `ALLOWED_ORDER_CREATE_FIELDS` allowlist on `orderData` immediately after destructure; dropped keys logged. Regression test `scripts/test-order-create-allowlist.js` (32/32). |
| M3/M8 | `rejectOrder` status flip outside tx | ✅ shipped | Reproduced & verdict: M3 was NOT exploitable today (the existing `refundEscrowToAdvertiser` throws on insufficient escrow, which accidentally blocked the double-refund on retry) — but the architectural gap was real. Fix: status flip moved INSIDE the service's existing `db.transaction`; added `SELECT … FOR UPDATE` row lock + idempotency pre-state check at the top. Covered by `scripts/test-cancel-reject-atomic.js` (34/34 incl. happy path + retry + crash injection). |
| M4 | Admin updateStatus bypasses money flow | ⏳ pending | |
| M5 | `completeOrder` revisionStatus guard | ✅ shipped | Reproduced & rescoped: audit's HAPPY-PATH framing is a FALSE POSITIVE — the natural state machine (requestRevision flips orderStatus→'accepted') gates a normal API attack. But two real exposures: (i) defense-in-depth gap — an inconsistent row (orderStatus='delivered' + revisionStatus='requested'/'in_progress' from a race, admin direct edit, or future regression) bypassed completeOrder's check and released escrow; (ii) requestRevision was not in a transaction, so a concurrent completeOrder could win the race and pay out while the revision request was in-flight. Fix: (a) `services.completeOrder` added `SELECT … FOR UPDATE` row lock + defensive `revisionStatus IN ('requested','in_progress')` guard; (b) `controllers.requestRevision` wrapped in `db.transaction` with the same row lock, re-fetches under the lock, rejects when the order has gone terminal. Regression test `scripts/test-revision-completion-guard.js` (26/26 incl. defense-in-depth, multi-cycle, concurrent race). |
| M6 | `disputeReason` column missing | ⏳ pending | |
| M7 | `cancelOrder` not transactional | ✅ shipped | Reproduced & confirmed: 2 refund tx + advertiser `mainBalance` doubled $50 → $100 when status-flip simulated to fail mid-flow. Same race reproduces in the daily cron's day-1 partial + day-2 retry. Fix: new `services.cancelOrderAtomic` wraps refund + status flip in a single `db.transaction` with `SELECT … FOR UPDATE` on the order row + idempotency pre-state check (terminal statuses skip; concurrent cancels serialize on the lock). `refundEscrowToAdvertiser` hardened: throws on insufficient escrow (no more `Math.max(0, …)` clamp) and refuses to write a 2nd refund tx when one already exists for the order (defense-in-depth). Controller `cancelOrder` and `src/cron/order-cancellation.js` both routed through the new atomic helper. Regression test `scripts/test-cancel-reject-atomic.js` (34/34 incl. crash-injection rollback + concurrent-cancel race + cron-retry idempotency). |
| M9 | Revision counter + upper bound | ⏳ pending | |
| M10 | `order-audit-log` only fires for cancel | ⏳ pending | |
| M11 | `createPayment` baseAmount tampering | ⚠ backend-shipped, browser-verify pending | Server-authoritative payment model implemented. `createPayment` now derives gateway charge AND wallet credit from a single `userIntent` via `computeFees` (in `services/payment.js`). All 3 vulnerable webhooks (Stripe / Razorpay / PayPal) cross-check actual gateway charge against `metadata.expectedChargeCents`; mismatch → no credit + tx marked `failed`. Deployed 2026-06-16 12:26 UTC. `/tmp/repro-m11-baseAmount-tampering.js` post-fix: "🟢 No divergence". Regression test `scripts/test-payment-baseAmount-tampering.js` (35/35). Full suite (12 tests) 287/287. **Not marked ✅ closed until live browser verification across Stripe, Razorpay, PayPal, PhonePe completes.** |
| M12 | Razorpay raw-body signature | ⏳ pending | |
| T1 | Bank-transfer enum mismatch | ⏳ pending | |
| T2 | Admin withdrawal pay race | ⏳ pending | |
| T4 | Admin withdrawals.pay() field names | ⏳ pending | |
| T5 | debugTransactions endpoint ungated | ⏳ pending | |
| T6 | Default /api/transactions routes | ⏳ pending | |
| T7 | Withdrawal create wallet lock | ⏳ pending | |
| T8 | `deliverOrder` TOCTOU | ⏳ pending | |
| T9 | PhonePe webhook non-atomic | ⏳ pending | |
| T10 | createPendingTransaction allowlist | ⏳ pending | |
| T11 | Public getTransactionStatus leak | ⏳ pending | |
| T12 | Public phonepe-status credit trigger | ⏳ pending | |
| T13 | Razorpay verifyPayment auth | ⏳ pending | |
| T14 | Generic /webhook/:gateway route | ⏳ pending | |

**Must-fix progress:** 0 of 26 shipped (12 verified HIGH + 14 Tier-2 from money-relevant MEDIUMs and unverified HIGHs).
**Should-fix:** 81 medium-severity items pending (see Should-fix section).
**Nice-to-have:** 37 low-severity items pending.
**Verification debt:** 94 HIGH findings dropped due to API session limit need to be re-run through the adversarial verify pass.

## Coverage notes by lens

The full coverage notes (each lens's "what I reviewed / what I deliberately skipped") are persisted at `/tmp/order_audit_coverage.txt`. Each of the 14 lenses cited its file/line ranges; the full file:line manifest of every finding is in `/tmp/order_audit_confirmed.json` for downstream verification or for converting individual entries into actionable Linear/Jira tickets.
