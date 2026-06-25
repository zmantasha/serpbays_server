# Realtime Wiring — Deployment Runbook

Covers the 8-pass realtime audit landing on `security-fixes` across three
repos (`serpbays_server`, `serpbays_client`, `serpbays-adminpanel/serpbays_admin`).

The audit added Socket.IO push for wallet, order, withdrawal,
bank-transfer, notification, marketplace, and admin-panel events;
introduced an admin/publisher room model; and made the seq/adapter layer
multi-pod safe behind `REDIS_URL`.

---

## 1. What's shipping

### New Socket.IO channels

**Per-user (rooms `user_<id>`):**
- `wallet:balance_updated` — every wallet mutation (deposit, spend, escrow lock/release, withdrawal pending/refund/paid, admin adjustment, bank transfer credit, promo, order completion, order cancellation refund)
- `order:status_changed` — every order transition (create, accept, reject, deliver, complete, cancel, dispute, revision flows)
- `withdrawal:status_changed` — pending → approved | denied → paid
- `bank_transfer:status_changed` — pending → processing | completed | rejected
- `notification` + `notification_count` — every notification + count delta (already in production before this audit; expanded to cover mark-as-read multi-tab sync)

**Admin fan-out (room `admins`):**
- `admin:wallet_event`, `admin:order_event`, `admin:withdrawal_event`, `admin:bank_transfer_event`

**Publisher broadcast (room `publishers`):**
- `order:created_for_marketplace` — new pending order with no assigned publisher

### Multi-pod infrastructure
- `@socket.io/redis-adapter` + `ioredis` deps added; activated when `REDIS_URL` is set
- Per-event seq counters moved from in-memory `Map<userId, seq>` to atomic `INCR rt:seq:<channel>:<uid>` when Redis is available; transparent in-memory fallback otherwise

### Auth / role gating
- WS handshake loads `user.role` and `user.Publisher` from the DB at connect-time (NOT from JWT claim) before joining `admins` / `publishers` rooms — a stale JWT from before a role downgrade cannot grant admin access
- Cross-check `query.userId === decoded.id` still in place (pass-1 defense-in-depth)

---

## 2. Pre-deployment checklist

- [ ] Confirm the latest commits are on `security-fixes`:
  - serpbays_server: `458c324` (or later if hotfixes landed)
  - serpbays_client: `eeb1054`
  - serpbays-adminpanel: `186427a`
- [ ] Confirm `package-lock.json` changes are committed in serpbays_server (`@socket.io/redis-adapter`, `ioredis`) and serpbays-adminpanel (`socket.io-client`)
- [ ] Confirm the dev environment was tested with realtime working (single-pod, no Redis)
- [ ] **Multi-pod deploys only**: a Redis instance is available. The audit's single-pod fallback path is correct but does NOT span pods — see §3.

---

## 3. Environment variables

### serpbays_server

| Variable | When required | Notes |
|---|---|---|
| `REDIS_URL` | Multi-pod deploys (production) | `redis://[:pass@]host:port/db` — same format `ioredis` accepts. Single-pod dev/staging can omit. |

If `REDIS_URL` is set, the bootstrap connects a pub/sub pair and attaches `io.adapter(...)`. The same client is reused by `src/utils/realtime-seq.js` for atomic seq counters. Connection failures are non-fatal (boots with in-memory adapter + logs the failure).

### serpbays_client

No new env vars. Uses existing `NEXT_PUBLIC_API_URL` for the WS endpoint.

### serpbays-adminpanel (panel20)

No new env vars. Uses existing `NEXT_PUBLIC_API_URL`. The Strapi JWT is read from the next-auth session (`session.user.jwt`).

---

## 4. Deploy order

Deploy **server first**, then clients. The server-side emits are additive — pre-pass-1 clients (without the WS listeners) silently ignore the new events, no breakage. The reverse is also safe — a new client connecting to an old server just doesn't receive events.

But if you deploy clients first, users hit the wiring before the events exist, which makes the "realtime" feature look broken until the server catches up. Server-first avoids that window.

### 4.1 serpbays_server

```bash
git fetch origin
git checkout security-fixes
git pull origin security-fixes

# Install the two new deps. Use --legacy-peer-deps because the repo's
# @strapi/design-system constraint conflicts with newer transitive deps.
npm install --legacy-peer-deps

# Set REDIS_URL in your process manager env file BEFORE restart.
# (Skip for single-pod deploys.)

# pm2 deploy pattern (matches the existing `backend-server` process):
pm2 restart backend-server --update-env
```

**Watch the boot log** (`pm2 logs backend-server --lines 50 --raw`) for:

- `[WS] Redis adapter attached — multi-pod fan-out enabled` (Redis path)
- OR `[WS] REDIS_URL not set — using default in-memory adapter (single-pod only)` (dev/single-pod path)
- `[WS] admin user <id> joined 'admins' room (role=admin)` on first admin connect
- `Strapi started successfully` — boot completes

**Red flags:**
- `[WS][redis-adapter:pub] <error>` or `[WS][redis-adapter:sub] <error>` — Redis is reachable but pub/sub is failing. Realtime is degraded to local-pod only.
- `[WS] Redis adapter init failed — falling back to in-memory: <error>` — the adapter couldn't be initialised at all. Check `REDIS_URL` value.
- `[WS] role lookup failed for user <id>: <error>` — a connecting user couldn't have their role checked. Their user channel still works but they won't join `admins` / `publishers` rooms.

### 4.2 serpbays_client

Standard Next.js build + restart:

```bash
git checkout security-fixes && git pull
npm install
npm run build
pm2 restart <client-process>
```

No DB migrations. No new env vars.

### 4.3 serpbays-adminpanel (panel20)

Same shape:

```bash
git checkout security-fixes && git pull
npm install
npm run build
pm2 restart serpbays-adminpanel
```

### 4.4 CRITICAL — Next.js build is the deploy boundary

Next.js compiles the client bundle at `npm run build` time and serves
the pre-compiled artifacts from `.next/` for the lifetime of the process.
The pm2 restart loads the new server-side code but **the client JS shipped
to admin browsers comes from the existing `.next/` directory**.

If you `pm2 restart` without `npm run build` first, you ship the OLD
bundle to every admin's browser — even though the source files on disk
look correct.

**Detection**: `stat -c '%y' .next/BUILD_ID` shows the timestamp of the
last build. It should match (or be after) the commit you intended to deploy.

**This bit us on 2026-06-25** — a refetchInterval polling bug-fix
landed on `security-fixes`, but the panel20 pm2 process had 5-day
uptime serving the pre-fix `.next/`. The on-disk source had the fix; the
running bundle didn't. Users reported "the fix didn't work" — accurate
description of what they saw, because the new code was never actually
running on the box.

### 4.5 Browser cache after a panel20 deploy

Static assets are now served with `Cache-Control: public, max-age=31536000,
immutable` (perf-pass-10). New builds get new content-hashed filenames
(`layout-<hash>.js`), so:

- **New tab / fresh login**: picks up new bundle automatically.
- **Already-open admin tab**: browser holds the OLD bundle until it sees
  a new HTML response referencing the new hash. After a deploy, tell
  admins with open tabs to do a hard refresh (Ctrl+Shift+R / Cmd+Shift+R).
  Until they refresh, they're running the old client code (which may
  poll, miss new WS channels, etc.) — but no data corruption risk;
  server is authoritative.

---

## 5. Post-deploy verification

### 5.1 Server-side smoke test (5 min)

The 8 regression-test scripts are static greps — they verify the code is in place, not that runtime emits work. For runtime verification:

```bash
# 1. Confirm Socket.IO is listening on the public port
curl -i "https://api.serpbays.com/socket.io/?EIO=4&transport=polling" | head -10
# Expect: HTTP/1.1 200 OK, response body like '0{"sid":"...","upgrades":["websocket"],...}'

# 2. Confirm the Redis pub/sub channel is alive (multi-pod deploys only).
# In a Redis REPL:
#   MONITOR
# Then trigger any wallet emit (e.g. apply a $0.01 admin adjustment in panel20
# to a test user). You should see `socket.io#/<random>#` pub/sub keys flash.

# 3. Confirm the role gate. From a test ADMIN account, open the browser dev
# tools network tab, filter to `socket.io`. In the connect handshake you
# should NOT see anything indicating room membership client-side — the room
# join happens server-side. Instead verify the server log shows
# `[WS] admin user <id> joined 'admins' room`.
```

### 5.2 End-to-end checks (10 min)

For each, open two browser tabs as the same user (or two devices) and confirm both tabs update without refresh.

| Flow | Steps | Expected |
|---|---|---|
| **Wallet deposit** | Add funds via Stripe (or simulate a webhook) | Both tabs' wallet pill increments. Wallet page balance card + transaction list refresh. |
| **Order accept** | Publisher accepts an order | Advertiser's order list reflows; the row's status badge flips to "Accepted" without refresh. Order count badges in navbar tick down/up. |
| **Order deliver** | Publisher submits link | Advertiser's order detail page shows the delivered URL. Advertiser notification bell increments + count syncs across tabs. |
| **Withdrawal lifecycle** | Publisher creates a withdrawal request | Publisher's earnings page balance + withdrawal history refresh. Admin's withdrawal queue in panel20 gets a new row at the top. |
| **Admin approves withdrawal** | Admin clicks Approve in panel20 | Publisher's withdrawal history row flips to "Approved". Publisher's wallet `pendingWithdrawal` updates. |
| **Bank transfer admin approve** | Admin marks a bank-transfer request as completed | Requesting user's wallet credits in real time. |
| **Marketplace broadcast** | Advertiser creates a new pending order (no publisher assigned) | All publisher tabs' /publisher/available-orders refreshes without polling. |
| **Mark notifications read in tab B** | Open notifications page in tab B, mark all read | Tab A's bell badge decrements to 0 without refresh. |
| **Admin adjustment cross-user** | Admin opens user A's detail page; from a separate tab, change user B's wallet | User A's detail page does NOT refetch (per-user filter is correct). |

### 5.3 Connection introspection (any time post-deploy)

Strapi exposes these globals for runtime introspection:

```javascript
// From a Strapi console / debug endpoint:
strapi.io.getConnectedUsers()  // [42, 99, 188, ...]
strapi.io.socketCount(42)      // 3 — user 42 has 3 tabs/devices open
strapi.io.adminSocketCount()   // 5 — five admin sockets connected
```

If staffing a release, drop these into a one-off `/admin/realtime-health` endpoint to monitor connection counts during ramp.

---

## 6. Rollback plan

Rollback is per-repo and additive — there's no migration to reverse. The previous head on each `security-fixes` branch (one commit back from the deployed sha) is a known-good baseline.

```bash
# serpbays_server
git checkout security-fixes
git revert --no-commit 458c324..HEAD   # revert all pass-8 commits cleanly
git commit -m "revert: rolling back realtime pass 8"
pm2 restart backend-server --update-env

# For a deeper rollback (all the way before the audit) the safe base
# is `44218f0~1`. Be aware that wallet polling / CustomEvent fan-out
# will resume from that point, which is the pre-audit behavior.
```

**Important rollback notes:**

1. If you roll back the server but NOT the client/panel20, clients will keep trying to subscribe to channels that no longer fire. This is harmless (just stale UI), but feels broken to users.
2. If you set `REDIS_URL` for the rollout and need to undo, unset it AND restart Strapi. The seq counters automatically switch back to in-memory.
3. The Redis `rt:seq:*` keys persist in Redis after rollback. They're 8-byte integers per (channel, user) and grow slowly; safe to ignore or `redis-cli --scan --pattern 'rt:seq:*' | xargs redis-cli DEL` if cleaning up.
4. If you roll back ONLY a client without rolling back the server, no harm — the older client just doesn't subscribe to the newer channels.

---

## 7. Monitoring

### Log lines worth alerting on

```
[WS][redis-adapter:pub]   # Redis pub failure — multi-pod fan-out broken
[WS][redis-adapter:sub]   # Redis sub failure — same
[realtime-seq:<channel>] redis INCR failed   # seq counter falling back to in-memory
[WS] Redis adapter init failed   # adapter unavailable from boot
```

Any of these on a multi-pod deploy means realtime cross-pod sync is silently degraded. The system continues to function — events just don't reach sockets on other pods.

### Metrics to track post-deploy

| Metric | Target | Where |
|---|---|---|
| Socket connections (active) | should match active session count | `strapi.io.getConnectedUsers().length` |
| Admin socket connections | matches logged-in admin count | `strapi.io.adminSocketCount()` |
| Redis pub/sub throughput | proportional to wallet/order activity | Redis `INFO stats` → `instantaneous_ops_per_sec` |
| Event emit failures | 0 / minute | grep `(non-fatal)` in server log |

### What "healthy" looks like

- Every wallet write produces a `wallet:balance_updated` emit logged at debug level (the helper logs nothing on success — silence is good).
- `admin:*` events fire only when at least one admin is connected (server checks `connectedAdmins.size > 0` for the return value — actual emit still happens regardless).
- Marketplace broadcasts only fire for orders where `result.publisher` is null at afterCreate time.

---

## 8. Known limitations / open items

These were flagged during the audit and explicitly deferred — not deploy blockers, but worth tracking:

1. **`useAvailableOrders` 30s staleTime fallback** — the WS path is now the primary update mechanism, but the staleTime backstop is still in place. If WS is down, publishers see up to 30s lag.

2. **Notification payload has no `seq`** — the `notification_count` push is an absolute count (not a delta), so reordering doesn't visibly drift state. Low-impact, but if rapid notifications produce visible UI flicker, adding a seq guard mirrors the wallet pattern.

3. **Mobile-nav has a Bell icon link but no unread badge** — confirmed during audit; not a regression, just a feature gap from before this work.

4. **Notification list pagination** — receiving a new notification while paginated to page 2+ doesn't prepend (intentional — page 2 is meant to be stable while reading). Will require a notification appearing on page 1 OR a manual refresh.

5. **Per-process backstops still in place**:
   - Layout.tsx has a 30s setInterval polling order counts as a disconnect-time backstop. Safe to leave; the WS path supersedes it when connected.
   - Dashboard hook has `refetchInterval: 2 * 60 * 1000` / `3 * 60 * 1000` as a disconnect-time backstop. Same — WS is primary.

6. **Single-pod assumption in dev** — without `REDIS_URL`, restart of Strapi resets all in-memory seq counters. Clients reconnecting will briefly drop events until their `lastSeq` is overtaken. Acceptable for dev; multi-pod production MUST have `REDIS_URL` set.

---

## 9. Reference

### Regression test commands

```bash
cd serpbays_server
for f in scripts/test-{wallet-realtime-pass1,wallet-realtime-pass2,realtime-pass3,realtime-pass4,realtime-pass5,realtime-pass6,realtime-pass7,realtime-pass8}.js; do
  node "$f" 2>&1 | tail -2
done
# Expected: 30/0, 28/0, 26/0, 28/0, 12/0, 22/0, 28/0, 22/0
# Total: 196/0
```

### Deployed shas (as of audit close)

| Repo | sha | Branch |
|---|---|---|
| serpbays_server | `458c324` | security-fixes |
| serpbays_client | `eeb1054` | security-fixes |
| serpbays-adminpanel | `186427a` | security-fixes |

### Channel → server emit site cheat-sheet

| Channel | Server emit site | Triggered by |
|---|---|---|
| `wallet:balance_updated` | `api::user-wallet.user-wallet.emitBalanceUpdate` | every wallet mutation across 21 controller / service / lifecycle sites |
| `order:status_changed` | `api::order.order.emitOrderUpdate` (via `order/lifecycles.js`) | order create + status field change |
| `withdrawal:status_changed` | `api::withdrawal-request.*.emitWithdrawalStatusChanged` (via `withdrawal-request/lifecycles.js`) | withdrawal create + status transition |
| `bank_transfer:status_changed` | `api::bank-transfer-request.*.emitBankTransferStatusChanged` (via `bank-transfer-request/lifecycles.js`) | bank-transfer create + status transition |
| `notification` + `notification_count` | `api::notification.notification` lifecycle + controller | notification create, markAsRead, markAllAsRead |
| `admin:*_event` | Fan-out from same helpers when `strapi.io.emitToAdmins` is called | every emit on the four channels above |
| `order:created_for_marketplace` | `api::order.order/lifecycles.js` afterCreate | new pending order with no publisher |
