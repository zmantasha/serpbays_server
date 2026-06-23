#!/usr/bin/env node
/**
 * Regression test — real-time wiring pass 8 (marketplace broadcast +
 * panel20 per-user drill-down).
 *
 * Closes the last two items the broader audit flagged but the earlier
 * passes deferred:
 *
 *   1. `useAvailableOrders` — a new pending order has no publisher
 *      relation yet, so the per-user channel can't reach the
 *      publishers waiting to pick it up. Adds a `publishers` Socket.IO
 *      room (joined at WS handshake when user.Publisher === true) plus
 *      a `order:created_for_marketplace` broadcast fired from the
 *      order lifecycle's afterCreate when result.publisher is null.
 *
 *   2. Panel20 per-user pages — users/[id] held a frozen wallet/tx
 *      snapshot, and AddTransactionModal closed without invalidating
 *      any query (relied on the parent onCreated callback). Both now
 *      respond to admin:* events scoped to the visible user.
 *
 * Run: cd serpbays_server && node scripts/test-realtime-pass8.js
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

const WS_BOOT = read('src/bootstrap/websocket.js');
const ORDER_LC = read('src/api/order/content-types/order/lifecycles.js');

const CLIENT = (rel) => read(`/var/www/serpbays/serpbays_client/${rel}`);
const C_WS = CLIENT('lib/services/websocketService.ts');
const C_AVAIL = CLIENT('app/(dashboard)/publisher/available-orders/hooks/useAvailableOrders.ts');

const P20 = (rel) => read(`/var/www/serpbays-adminpanel/serpbays_admin/${rel}`);
const P_USER = P20('src/app/users/[id]/page.tsx');
const P_MODAL = P20('src/components/AddTransactionModal.tsx');

out('\n=== 1) Server: publishers room + emitToPublishers ===');
assert(/connectedPublishers\s*=\s*new\s+Set\(\)/.test(WS_BOOT),
  'connectedPublishers Set declared');
assert(/!!userWithRole\?\.Publisher/.test(WS_BOOT),
  'publisher detection reads user.Publisher boolean from DB');
assert(/socket\.join\(['"]publishers['"]\)/.test(WS_BOOT),
  'publisher sockets join publishers room');
assert(/strapi\.io\.emitToPublishers\s*=/.test(WS_BOOT),
  'emitToPublishers helper attached');
assert(/io\.to\(['"]publishers['"]\)\.emit/.test(WS_BOOT),
  'emitToPublishers routes via io.to(publishers)');
assert(/isPublisher\s*=\s*!!userWithRole\?\.Publisher/.test(WS_BOOT),
  'isPublisher flag captured at connect-time');

out('\n=== 2) Server: order lifecycle marketplace broadcast ===');
assert(/emitToPublishers\(\s*['"]order:created_for_marketplace['"]/.test(ORDER_LC),
  'afterCreate calls emitToPublishers on order:created_for_marketplace');
assert(/!fresh\.publisher\?\.id/.test(ORDER_LC),
  'broadcast only when order has no assigned publisher (unassigned == marketplace)');
assert(/populate:\s*\[\s*['"]publisher['"]\s*\]/.test(ORDER_LC),
  'lifecycle re-loads result with publisher populate to make the gating decision');

out('\n=== 3) Client: websocketService marketplace channel ===');
assert(/export\s+interface\s+MarketplaceOrderCreatedEvent/.test(C_WS),
  'MarketplaceOrderCreatedEvent type exported');
assert(/onMarketplaceOrderCreated\(handler:\s*MarketplaceOrderHandler\)/.test(C_WS),
  'onMarketplaceOrderCreated registration API exposed');
assert(/this\.socket\.on\(\s*['"]order:created_for_marketplace['"]/.test(C_WS),
  'client subscribes to order:created_for_marketplace channel');

out('\n=== 4) Client: useAvailableOrders invalidates on marketplace + status events ===');
assert(/websocketService\.onMarketplaceOrderCreated\(/.test(C_AVAIL),
  'useAvailableOrders subscribes to marketplace channel');
assert(/invalidateQueries\(\{\s*queryKey:\s*\[['"]availableOrders['"]\]\s*\}\)/.test(C_AVAIL),
  'handler invalidates [availableOrders] query key');
assert(/websocketService\.onOrderUpdate\([\s\S]{0,200}event\.side\s*===\s*['"]publisher['"]/.test(C_AVAIL),
  'also invalidates on order:status_changed (publisher side) — covers claimed/canceled');

out('\n=== 5) Panel20: users/[id] subscribes to per-user filtered events ===');
assert(/adminWebsocketService\.onWalletEvent\([\s\S]{0,200}event\.userId\s*===\s*targetId/.test(P_USER),
  'wallet event handler filters by event.userId === targetId');
assert(/adminWebsocketService\.onWithdrawalEvent\([\s\S]{0,200}event\.publisherId\s*===\s*targetId/.test(P_USER),
  'withdrawal event handler filters by event.publisherId === targetId');
assert(/adminWebsocketService\.onBankTransferEvent\([\s\S]{0,200}event\.userId\s*===\s*targetId/.test(P_USER),
  'bank-transfer event handler filters by event.userId === targetId');
assert(/adminWebsocketService\.onOrderEvent\([\s\S]{0,300}event\.advertiserId\s*===\s*targetId\s*\|\|\s*event\.publisherId\s*===\s*targetId/.test(P_USER),
  'order event handler matches either side of the user being viewed');

out('\n=== 6) Panel20: AddTransactionModal invalidates on submit success ===');
assert(/useQueryClient/.test(P_MODAL),
  'modal imports useQueryClient');
assert(/queryClient\.invalidateQueries\(\{\s*queryKey:\s*queryKeys\.users\.detail\(selectedUser\.id\)/.test(P_MODAL),
  'invalidates users.detail(id) on success');
assert(/queryClient\.invalidateQueries\(\{\s*queryKey:\s*queryKeys\.dashboard\.all/.test(P_MODAL),
  'invalidates dashboard.all on success');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
