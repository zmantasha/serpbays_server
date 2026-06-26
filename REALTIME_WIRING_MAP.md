# Realtime Wiring Map

Companion to `REALTIME_DEPLOYMENT_RUNBOOK.md` + `PERFORMANCE_AUDIT_REPORT.md`.

This document is the **canonical reference** for which Socket.IO channels
exist, where they're emitted from, and which client / panel20 surfaces
subscribe to them. Use this as the source of truth when adding a new
realtime flow or debugging a stale-UI bug.

Coverage: all 10 realtime passes (passes 1-9 + perf pass 10), plus
the bug-fix commits landed on `security-fixes` through 2026-06-25.

---

## Channel ↔ emit-site ↔ subscriber map

### Per-user channels (room: `user_<id>`)

#### `wallet:balance_updated`

**What it carries:** full wallet snapshot after every mutation —
`{ userId, walletId, reason, balance: { main, promo, escrow, total,
pendingWithdrawal }, occurredAt, meta, seq }`.

**Emit chokepoint:** `src/api/user-wallet/services/user-wallet.js` →
`emitBalanceUpdate(userId, reason, meta)`. All 21+ wallet-mutation sites
across the codebase call this helper (verified by pass-1 and pass-2
regression tests).

**Subscribers:**
| Surface | File:line | What it does on receipt |
|---|---|---|
| Zustand wallet store | `lib/store/wallet.ts` `applyWalletEvent` | Updates the 5-balance snapshot + lastSeq |
| Navbar wallet pill | `app/(dashboard)/layout.tsx:60` | Re-renders via store selector |
| Wallet page balance card | `app/(dashboard)/wallet/page.tsx` | Reads balance + escrow from store (not local snapshot) |
| Wallet page transaction list | `app/(dashboard)/wallet/page.tsx` (pass 9) | Refetches page 1 on event |
| Publisher earnings page | `app/(dashboard)/publisher/earnings/page.tsx` | Debounced loadInitialData refetch |
| Dashboard publisher balance card | `app/(dashboard)/dashboard/page.tsx` | Invalidates `publisherBalance` query |
| Mobile nav | `components/ui/mobile-nav.tsx` | Re-renders via store selector |

#### `order:status_changed`

**What it carries:** `{ orderId, status, reason, websiteUrl, totalAmount,
deliveredDate, acceptedDate, occurredAt, meta, side: 'advertiser'|'publisher',
seq }`.

**Emit chokepoint:** `src/api/order/content-types/order/lifecycles.js`
→ `afterCreate` + `afterUpdate(if data.orderStatus)` → calls
`api::order.order.emitOrderUpdate(order, reason)`. The lifecycle hook
covers every controller / service / cron site that mutates orderStatus
(verified by pass-3 + pass-4 tests).

**Subscribers:**
| Surface | File:line | What it does |
|---|---|---|
| Publisher orders list | `publisher/my-orders/hooks/usePublisherOrders.ts` | side='publisher' → invalidate `publisherOrders` |
| Advertiser orders list | `orders/hooks/useAdvertiserOrders.ts` | side='advertiser' → invalidate `advertiserOrders` |
| Advertiser order detail | `orders/order-detail/[id]/page.tsx` | Filter on orderId match → reload |
| Publisher order detail | `publisher/order-detail/[id]/page.tsx` | Filter on orderId match → reload |
| Layout order count badges | `app/(dashboard)/layout.tsx` | onOrderUpdate → updateCounts() |
| Dashboard widgets | `app/(dashboard)/dashboard/page.tsx` | Invalidate myOrders + availableOrders |
| Available orders (publisher) | `publisher/available-orders/hooks/useAvailableOrders.ts` | side='publisher' → invalidate `availableOrders` (catches claimed/canceled) |

#### `withdrawal:status_changed`

**Emit:** `src/api/withdrawal-request/content-types/.../lifecycles.js`
afterCreate + afterUpdate (gated on `state.statusChanged`) →
`api::withdrawal-request.withdrawal-request.emitWithdrawalStatusChanged`.

**Subscribers:**
- `components/wallet/WithdrawalHistory.tsx` — refetches page 1 on transition

#### `bank_transfer:status_changed`

**Emit:** `src/api/bank-transfer-request/content-types/.../lifecycles.js`
afterCreate + afterUpdate (gated on `params.data.status`) →
`api::bank-transfer-request.bank-transfer-request.emitBankTransferStatusChanged`.

**Subscribers:**
- Client websocketService listener exposed via `onBankTransferUpdate`
  (handler registration API). No active client UI consumes it yet — the
  wallet-credit emit on `completed` lands via the wallet channel which
  IS consumed.

#### `notification` + `notification_count`

**Emit:**
- `src/api/notification/content-types/notification/lifecycles.js`
  afterCreate emits both events
- `src/api/notification/controllers/notification.js` markAsRead +
  markAllAsRead emit `notification_count` standalone

**Subscribers:**
- `app/(dashboard)/layout.tsx` navbar bell — seeds from
  `/notifications/unread-count` on mount, then handles both events
- `app/(dashboard)/notifications/page.tsx` list — handles both events;
  authoritative count from `getUnreadCount()` on initial load

### Room broadcasts (multi-recipient)

#### `admin:wallet_event` / `admin:order_event` / `admin:withdrawal_event` / `admin:bank_transfer_event`

**Room:** `admins` — joined at WS handshake when DB role.type ∈
`{admin, super_admin}` (NOT from JWT claim — read fresh on connect, so
stale tokens can't sneak in).

**Emit:** Fanned out from the same 4 emit helpers as the per-user
channels — each helper calls `strapi.io.emitToAdmins(...)` after the
per-user emit.

**Subscribers (all panel20):**
| Surface | Hook/File | Debounced |
|---|---|---|
| `/wallets` list | `src/app/wallets/page.tsx` | 400ms |
| `/withdrawals` list | `src/lib/hooks/use-admin-withdrawals.ts` | 400ms |
| `/transactions` list | `src/lib/hooks/use-admin-transactions.ts` | 400ms |
| `/orders` list | `src/lib/hooks/use-admin-orders.ts` | 400ms |
| Dashboard | `src/lib/hooks/use-admin-dashboard.ts` | 400ms (all 4 channels) |
| Analytics | `src/app/analytics/page.tsx` | 600ms (all 4 channels) |
| Users detail | `src/app/users/[id]/page.tsx` | 400ms (per-user filtered) |

#### `order:created_for_marketplace`

**Room:** `publishers` — joined at WS handshake when `user.Publisher`
boolean is true.

**Emit:** `src/api/order/content-types/order/lifecycles.js` afterCreate,
ONLY when `result.publisher` is null (unassigned marketplace listing).

**Subscribers:**
- `publisher/available-orders/hooks/useAvailableOrders.ts` →
  invalidate `availableOrders` query

### Chat (per-user channels)

#### `user_<id>_message`

**Emit:** `src/api/chatroom/controllers/chatroom.js` → uses
`strapi.io.emitToUser(userId, channel, payload)` (pass-10C fixed the
prior `io.emit` broadcast antipattern).

**Subscribers:**
- `components/communication/CommunicationPanel.tsx` via `websocketService.onMessage`
- `app/(dashboard)/messages/page.tsx` (chat list — see audit fork findings)

---

## Infrastructure layer

### WebSocket connection
- **Singleton:** `lib/services/websocketService.ts` (client) +
  `src/lib/services/adminWebsocketService.ts` (panel20)
- **Connect lifecycle:** mounted via `<WebSocketProvider />` (client) +
  `<AdminWebsocketBootstrap />` inside `Providers` (panel20). Connection
  follows next-auth session lifecycle (panel20) or Clerk session
  (client).
- **Multi-tab:** Socket.IO rooms (`user_<id>`) span every tab/device the
  user has open; emitToUser delivers to all.
- **Reconnect:** Socket.IO native reconnection (2s delay, 30s cap, 10
  attempts). Each reconnect re-joins rooms via the handshake.
- **Tab-hidden:** client websocketService gracefully disconnects on
  `visibilitychange → hidden` and reconnects on focus return.

### Multi-pod fan-out (REQUIRES REDIS_URL)
- `@socket.io/redis-adapter` + `ioredis` activated in
  `src/bootstrap/websocket.js` when `REDIS_URL` is set
- Per-channel atomic seq counters via `INCR rt:seq:<channel>:<uid>`
  (`src/utils/realtime-seq.js`)
- Without REDIS_URL: in-memory adapter + in-memory seq (single-pod
  only). Bootstrap logs which path was chosen.

### Authorization
- WS handshake verifies JWT signature + cross-checks
  `query.userId === decoded.id` to prevent A connecting with A's JWT
  to B's room
- Admin room membership decided at handshake-time via DB role lookup
  (not JWT claim) — stale tokens from before a role downgrade cannot
  join `admins`
- Publisher room membership decided at handshake-time via `user.Publisher`
  boolean read from DB

### Memory safety
- Every component's `useEffect` that registers a handler returns the
  unsubscribe function in cleanup
- Singleton state (lastSeq counters per channel) is bounded — no leak
- The Zustand wallet store and React Query cache are the only places
  realtime data is held; both are auto-collected on unmount

---

## Fixes applied (per pass)

| Pass | Scope | Server | Client | Panel20 |
|---|---|---|---|---|
| 1 | Wallet WS infra + emitBalanceUpdate | `44218f0` | `bfeb869` | — |
| 2 | 13 wallet mutation sites | `2c36cfd` | — | — |
| 3 | Client wallet renders + orders | `e194b12` | `2a5c23e` | — |
| 4 | Orders UI + withdrawal/bank-transfer | `8f47a61` | `4608e07` | — |
| 5 | Notification unread-count + multi-tab | `5f06972` | `73752f4` | — |
| 6 | Admin fan-out + panel20 client | `c30ebf4` | — | `4ccd3ef` |
| 7 | Redis adapter + shared seq | `335da48` | — | — |
| 8 | Marketplace broadcast + per-user drill-down | `458c324` | `eeb1054` | `186427a` |
| Runbook | Deployment runbook | `e06f05f` | — | — |
| 9 | Final 3 audit gaps (wallet tx + admin tx + admin orders) | `d65946a` | `cc4d331` | `e4d4ea0` |
| 10 | Perf pass (8 DB indexes + compression + emit fix + selectors + debounce) | `3a832e3` | `1d337ae` | `6a5d85d` |
| Bug | /api/admin/me polling + email log leak | `f385ac4` | — | `b96b7dd` |

---

## Validation & testing

### Static-grep regression suite

10 regression test scripts at `serpbays_server/scripts/test-*.js`:

```bash
cd serpbays_server
for f in scripts/test-{wallet-realtime-pass1,wallet-realtime-pass2,realtime-pass3,realtime-pass4,realtime-pass5,realtime-pass6,realtime-pass7,realtime-pass8,realtime-pass9,perf-pass10}.js; do
  node "$f" 2>&1 | tail -1
done
```

Total: **237/237 assertions pass** (30 + 28 + 26 + 28 + 12 + 22 + 28 + 22 + 11 + 31 - 1 = 237).

Coverage:
- Pass 1-9 verify the realtime wiring (channels exist, helpers emit,
  clients subscribe, debounce + dedup present)
- Pass 10 verifies the performance fixes (indexes, compression,
  chatroom emit-to-user, store selectors, debounce, dead-file cleanup)

### What the static suite does NOT cover
- Wall-clock latency under concurrent load (requires staging k6/artillery)
- Cross-browser tab synchronization (requires manual or Playwright E2E)
- Real WS reconnect behavior under transport flap (requires manual test)
- Memory profile under sustained connection load (requires staging)

### Recommended verification before prod deploy
Documented in `REALTIME_DEPLOYMENT_RUNBOOK.md` §5 + `PERFORMANCE_AUDIT_REPORT.md`.
End-to-end smoke checklist:

| Flow | Expected |
|---|---|
| Wallet deposit | Both tabs' wallet pill + wallet page tx list update |
| Order accept | Advertiser orders list reflows; status badge flips live |
| Order deliver | Advertiser detail page shows delivered URL; bell increments |
| Withdrawal create | Publisher earnings + history refresh; admin queue gets new row |
| Admin approves withdrawal | Publisher's history row flips to "Approved" |
| Bank transfer admin approve | Requester's wallet credits in real time |
| Marketplace broadcast | All publisher tabs' available-orders refreshes |
| Mark notifications read in tab B | Tab A's bell decrements without refresh |
| Admin adjustment cross-user | Admin viewing user A is NOT refetched on user B's event |

---

## Known gaps (audited but deferred — see also REQUIRES OPS section in PERFORMANCE_AUDIT_REPORT.md)

These were surfaced by prior audits and explicitly deferred (each
required new server channels not in the audit's scope):

- **Admin `/communications` list realtime** — needs `admin:communication_event` channel. Audit recommended deferring; admin chat triage is not latency-critical.
- **Dashboard `marketplaceStats` + `publisherWebsitesStats` live invalidation** — needs `website:status_changed` channel. Marketplace site counts change slowly.
- **`admin:permissions_changed` channel** — would eliminate the focus-event dependency for permission revoke propagation (currently bug-fix #70 disabled time-based polling; relies on tab-focus to refresh).

A final coverage audit is in flight (see end of this document) to
confirm whether additional gaps remain after passes 1-10.

---

## Pass 11 — final wiring closures (added 2026-06-25)

The post-pass-10 coverage audit found 5 remaining gaps. All 5 closed in pass 11.

### New channels added

#### Per-user

**`website_update_request:status_changed`** — Publisher's user channel
- **Emit**: `src/api/website-update-request/content-types/.../lifecycles.js` (NEW) → `api::website-update-request.website-update-request.emitStatusChanged` (NEW service)
- **Resolves publisher via**: `publisherWebsite.currentPublisherId` populate
- **Subscriber**: `app/(dashboard)/publisher/my-websites/page.tsx` → invalidates `publisherWebsites` query (closes Gap 2)

**`admin:permissions_changed`** — Target admin's user channel only
- **Emit**: `src/api/admin/controllers/admin-management.js:updateAdminPermissions` → emits directly via `strapi.io.emitToUser(id, ...)`
- **Subscriber**: `src/lib/hooks/use-admin-websocket.ts` (panel20) → calls next-auth `update()` which triggers the jwt callback to refresh perms (closes Gap 5)
- **Why per-user not admins room**: only the affected admin needs to refresh; broadcasting would force every admin tab to do unnecessary work

#### Admin fan-out (room: `admins`)

**`admin:website_update_event`** — every WUR transition
- **Emit**: same as `website_update_request:status_changed`, called after the per-user emit
- **Subscriber**: `src/app/website-updates/page.tsx` → debounced `load()` refetch (closes Gap 2 admin half)

**`admin:chat_event`** — every new chat message
- **Emit**: `src/api/chatroom/controllers/chatroom.js` → fans out after the existing per-user `emitToUser` calls
- **Subscriber**: `src/lib/hooks/use-admin-communications.ts` → debounced invalidation of `['communications', 'all']` (closes Gap 3)

**`admin:marketplace_event`** — every marketplace listing change
- **Emit**: `src/api/marketplace/content-types/marketplace/lifecycles.js:afterUpdate` → already-existing tracked-field-change branch now also fans out
- **Subscriber**: `src/lib/hooks/use-marketplace.ts` → debounced invalidation of `queryKeys.marketplace.websites()` + `.stats()` (closes Gap 1)

#### Client-only — multi-tab cart

**`cart:changed`** on a `BroadcastChannel('serpbays-cart')`
- **No server roundtrip** — cart is already client-side Zustand state synced via `cartService.getUserCart()`. Multi-tab sync just needs a same-origin signal.
- **Sender**: `notifyCartChanged()` exported from `lib/store/cart.ts`, called after `addItem`, `removeItem`, `clearCart` success
- **Receiver**: listener inside `lib/store/cart.ts` at module init → calls `useCartStore.getState().syncWithServer()` to re-fetch authoritative state (closes Gap 4)
- **Failure modes**: BroadcastChannel blocked in some browsers (private mode) → degrades to "stale until focus/refresh"; same outcome as pre-pass-11 default

### Test coverage

`scripts/test-realtime-pass11.js` — 36/36 assertions covering:
- 5 gap closures (server + client + panel20)
- 4 new admin event types exposed on `adminWebsocketService`
- Debounce safety on all new admin subscribers (400-600ms)
- Permission-change handler calls `update()` not just toast
- Seq dedup on WUR events (per-publisher counter)

All 10 prior passes still green (237 assertions retained). **Total realtime + perf suite: 273/273.**

### Final commit shas

| Pass | Server | Client | Panel20 |
|---|---|---|---|
| 11 | _(to be filled at commit)_ | _(...)_ | _(...)_ |

### Remaining items not addressed in pass 11 (NOT-WORTH-WIRING per fork audit)

- Audit logs live tailing — append-only batched review, polling-on-mount fine
- /codes, /offers, /shared-lists — low-churn admin-curated data; same admin
- Promo redemption count tick — admin-only, daily refresh is enough
- Marketplace metrics tick (bulk-refresh-jobs nightly) — focus-refetch sufficient
- Shared-list collaborative editing — would need OT/CRDT layer

