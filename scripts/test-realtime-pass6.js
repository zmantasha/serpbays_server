#!/usr/bin/env node
/**
 * Regression test — real-time wiring pass 6 (admin panel20).
 *
 * panel20 (the serpbays-admin Next.js app at /var/www/serpbays-adminpanel/
 * serpbays_admin) had ZERO socket client code. Every admin page was
 * fetch-on-mount; an admin watching the wallets list never saw a deposit
 * land in real time, an admin approving a withdrawal in tab B never had
 * tab A's queue update.
 *
 * Pass 6 adds:
 *
 *   SERVER (additive — does not change existing user channels):
 *   - src/bootstrap/websocket.js — on connect, after JWT verify, load the
 *     user with role from the DB. If role.type ∈ {admin, super_admin},
 *     join `admins` room. The JWT claim alone isn't trusted — a stale
 *     token from before a role downgrade cannot enter the admins room.
 *   - Same file — `strapi.io.emitToAdmins(event, data)` helper +
 *     `adminSocketCount()` introspection.
 *   - Four emit helpers fan-out to admins room with prefixed channel
 *     names (admin:wallet_event / admin:order_event /
 *     admin:withdrawal_event / admin:bank_transfer_event).
 *
 *   PANEL20 (new infra):
 *   - src/lib/services/adminWebsocketService.ts (NEW) — singleton,
 *     mirrors the client websocket service but reads JWT from next-auth
 *     session and subscribes to admin:* channels.
 *   - src/lib/hooks/use-admin-websocket.ts (NEW) — auto-connect/
 *     disconnect hook driven by next-auth session status.
 *   - src/app/providers.tsx — mounts the singleton's lifecycle hook
 *     inside AuthSessionProvider so the socket is up by the time pages
 *     register handlers.
 *
 *   PANEL20 (page wiring):
 *   - src/app/wallets/page.tsx — debounced refetch on onWalletEvent.
 *   - src/lib/hooks/use-admin-withdrawals.ts — invalidate
 *     withdrawals.lists() + .stats() on onWithdrawalEvent.
 *   - src/lib/hooks/use-admin-dashboard.ts — invalidate dashboard.all on
 *     ALL four event channels.
 *   - src/app/analytics/page.tsx — debounced fetchAll on all four
 *     channels (KPI cards span all modules).
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-realtime-pass6.js
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

// Server
const WS_BOOT = read('src/bootstrap/websocket.js');
const UW_SVC  = read('src/api/user-wallet/services/user-wallet.js');
const ORDER   = read('src/api/order/services/order.js');
const WR_SVC  = read('src/api/withdrawal-request/services/withdrawal-request.js');
const BTR_SVC = read('src/api/bank-transfer-request/services/bank-transfer-request.js');

// Panel20
const P20 = (rel) => read(`/var/www/serpbays-adminpanel/serpbays_admin/${rel}`);
const P_WS    = P20('src/lib/services/adminWebsocketService.ts');
const P_HOOK  = P20('src/lib/hooks/use-admin-websocket.ts');
const P_PROV  = P20('src/app/providers.tsx');
const P_WAL   = P20('src/app/wallets/page.tsx');
const P_WIT   = P20('src/lib/hooks/use-admin-withdrawals.ts');
const P_DASH  = P20('src/lib/hooks/use-admin-dashboard.ts');
const P_ANL   = P20('src/app/analytics/page.tsx');
const P_PKG   = P20('package.json');

out('\n=== 1) Server: admin room + emitToAdmins ===');
assert(/connectedAdmins\s*=\s*new\s+Set\(\)/.test(WS_BOOT),
  'connectedAdmins Set declared');
assert(/strapi\.entityService\.findOne\([\s\S]{0,80}plugin::users-permissions\.user[\s\S]{0,200}populate:\s*\['role'\]/.test(WS_BOOT),
  'role lookup via entityService (DB, not JWT claim)');
assert(/roleType === ['"]admin['"] \|\| roleType === ['"]super_admin['"]/.test(WS_BOOT),
  'role check accepts admin + super_admin');
assert(/socket\.join\(['"]admins['"]\)/.test(WS_BOOT),
  'admin sockets join the admins room');
assert(/strapi\.io\.emitToAdmins\s*=/.test(WS_BOOT),
  'emitToAdmins helper attached to strapi.io');
assert(/io\.to\(['"]admins['"]\)\.emit/.test(WS_BOOT),
  'emitToAdmins routes via io.to(admins)');

out('\n=== 2) Server: four emit helpers fan out to admins ===');
assert(/strapi\.io\.emitToAdmins\(\s*['"]admin:wallet_event['"]/.test(UW_SVC),
  'wallet emit fans out admin:wallet_event');
assert(/strapi\.io\.emitToAdmins\(\s*['"]admin:order_event['"]/.test(ORDER),
  'order emit fans out admin:order_event');
assert(/strapi\.io\.emitToAdmins\(\s*['"]admin:withdrawal_event['"]/.test(WR_SVC),
  'withdrawal emit fans out admin:withdrawal_event');
assert(/strapi\.io\.emitToAdmins\(\s*['"]admin:bank_transfer_event['"]/.test(BTR_SVC),
  'bank-transfer emit fans out admin:bank_transfer_event');

out('\n=== 3) Panel20: socket.io-client installed + adminWebsocketService exists ===');
assert(/"socket\.io-client"/.test(P_PKG),
  'socket.io-client added to package.json');
assert(/export\s+interface\s+AdminWalletEvent/.test(P_WS) &&
       /export\s+interface\s+AdminOrderEvent/.test(P_WS) &&
       /export\s+interface\s+AdminWithdrawalEvent/.test(P_WS) &&
       /export\s+interface\s+AdminBankTransferEvent/.test(P_WS),
  'all 4 event interfaces exported');
assert(/onWalletEvent\(handler:\s*WalletHandler\)/.test(P_WS) &&
       /onOrderEvent\(handler:\s*OrderHandler\)/.test(P_WS) &&
       /onWithdrawalEvent\(handler:\s*WithdrawalHandler\)/.test(P_WS) &&
       /onBankTransferEvent\(handler:\s*BankTransferHandler\)/.test(P_WS),
  'all 4 registration APIs exposed');
assert(/this\.socket\.on\(\s*['"]admin:wallet_event['"]/.test(P_WS) &&
       /this\.socket\.on\(\s*['"]admin:order_event['"]/.test(P_WS) &&
       /this\.socket\.on\(\s*['"]admin:withdrawal_event['"]/.test(P_WS) &&
       /this\.socket\.on\(\s*['"]admin:bank_transfer_event['"]/.test(P_WS),
  'subscribes to all 4 admin channels');
assert(/lastWalletSeqByUser\s*=\s*new\s+Map/.test(P_WS),
  'wallet seq dedup is PER-USER (different users have separate counters)');

out('\n=== 4) Panel20: auto-connect hook + Providers mount ===');
assert(/useSession\(\)/.test(P_HOOK) && /adminWebsocketService\.connect/.test(P_HOOK),
  'hook calls connect with the next-auth session JWT');
assert(/status === ['"]unauthenticated['"][\s\S]{0,80}disconnect/.test(P_HOOK),
  'hook disconnects on sign-out');
assert(/AdminWebsocketBootstrap/.test(P_PROV) && /useAdminWebsocket\(\)/.test(P_PROV),
  'Providers mount the bootstrap component');

out('\n=== 5) Panel20: page wiring ===');
assert(/adminWebsocketService\.onWalletEvent\(/.test(P_WAL),
  'wallets list page subscribes to onWalletEvent');
assert(/adminWebsocketService\.onWithdrawalEvent\(/.test(P_WIT) &&
       /invalidateQueries\(\{\s*queryKey:\s*queryKeys\.withdrawals\.lists\(\)/.test(P_WIT),
  'withdrawals hook invalidates lists on event');
assert(/adminWebsocketService\.onWalletEvent\(/.test(P_DASH) &&
       /adminWebsocketService\.onOrderEvent\(/.test(P_DASH) &&
       /adminWebsocketService\.onWithdrawalEvent\(/.test(P_DASH) &&
       /adminWebsocketService\.onBankTransferEvent\(/.test(P_DASH),
  'dashboard hook subscribes to all 4 channels');
assert(/adminWebsocketService\.onWalletEvent\(/.test(P_ANL),
  'analytics page subscribes (sample of 4 channels — debounced)');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
