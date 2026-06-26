#!/usr/bin/env node
/**
 * Regression test — real-time wiring pass 11 (final wiring closures).
 *
 * Closes the 5 gaps the post-pass-10 coverage audit surfaced. Each is a
 * direct extension of the established pattern (server lifecycle / emit
 * chokepoint → admin fan-out → client + panel20 subscribers).
 *
 *   Gap 1 — Marketplace listing changes (admin pages stale)
 *           → admin:marketplace_event from marketplace afterUpdate
 *
 *   Gap 2 — Website-update-request flow (publisher my-websites + admin
 *           queue stale)
 *           → website_update_request:status_changed (user channel)
 *           + admin:website_update_event (admins room)
 *           via new lifecycle + service helper
 *
 *   Gap 3 — Admin /communications stale on new chat messages
 *           → admin:chat_event from chatroom controller fan-out
 *
 *   Gap 4 — Cart multi-tab sync (tab A adds, tab B stale)
 *           → BroadcastChannel API (purely client-side, no server
 *             roundtrip — cart is already client state synced via
 *             cartService.syncWithServer)
 *
 *   Gap 5 — Permissions change propagation (admin stale until
 *           tab-focus, post bug-fix-#70 polling removal)
 *           → admin:permissions_changed to TARGET user only
 *             (NOT admins room — only the affected admin needs to
 *             refresh their session)
 *
 * Run: cd serpbays_server && node scripts/test-realtime-pass11.js
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

const WUR_SVC = read('src/api/website-update-request/services/website-update-request.js');
const WUR_LC = read('src/api/website-update-request/content-types/website-update-request/lifecycles.js');
const MP_LC = read('src/api/marketplace/content-types/marketplace/lifecycles.js');
const CHAT_CTRL = read('src/api/chatroom/controllers/chatroom.js');
const ADMIN_MGMT = read('src/api/admin/controllers/admin-management.js');

const CLIENT = (rel) => read(`/var/www/serpbays/serpbays_client/${rel}`);
const C_WS = CLIENT('lib/services/websocketService.ts');
const C_MW = CLIENT('app/(dashboard)/publisher/my-websites/page.tsx');
const C_CART = CLIENT('lib/store/cart.ts');

const PANEL = (rel) => read(`/var/www/serpbays-adminpanel/serpbays_admin/${rel}`);
const P_WS = PANEL('src/lib/services/adminWebsocketService.ts');
const P_HOOK = PANEL('src/lib/hooks/use-admin-websocket.ts');
const P_WU = PANEL('src/app/website-updates/page.tsx');
const P_MP = PANEL('src/lib/hooks/use-marketplace.ts');
const P_COMM = PANEL('src/lib/hooks/use-admin-communications.ts');

out('\n=== Gap 1 — marketplace lifecycle → admin:marketplace_event ===');
assert(/emitToAdmins\([\s\S]{0,80}['"]admin:marketplace_event['"]/.test(MP_LC),
  'marketplace afterUpdate fans out admin:marketplace_event');
assert(/changedFields/.test(MP_LC) && /admin:marketplace_event/.test(MP_LC),
  'event payload carries changedFields (admins know what to refetch)');

out('\n=== Gap 2 — website-update-request lifecycle + service helper ===');
assert(/createCoreService\(['"]api::website-update-request\.website-update-request['"]/.test(WUR_SVC),
  'service file created with core service shape');
assert(/async\s+emitStatusChanged\s*\(/.test(WUR_SVC),
  'emitStatusChanged service method defined');
assert(/emitToUser\(publisherId,\s*['"]website_update_request:status_changed['"]/.test(WUR_SVC),
  'per-user emit on publisher channel');
assert(/emitToAdmins\(['"]admin:website_update_event['"]/.test(WUR_SVC),
  'admin fan-out emit');
assert(/currentPublisherId/.test(WUR_SVC),
  'publisher resolved via publisherWebsite.currentPublisherId');
assert(/async\s+afterCreate/.test(WUR_LC) && /emitStatusChanged/.test(WUR_LC),
  'lifecycle afterCreate calls emit helper');
assert(/async\s+afterUpdate[\s\S]{0,400}params\.data[\s\S]{0,80}['"]status['"]/.test(WUR_LC),
  'lifecycle afterUpdate gated on params.data.status (no spam on note edits)');

out('\n=== Gap 3 — chatroom admin fan-out ===');
assert(/emitToAdmins\(['"]admin:chat_event['"]/.test(CHAT_CTRL),
  'chatroom controller fans out admin:chat_event');
// Make sure the existing per-user emits are still present
assert(/emitToUser\(chatroom\.advertiser\.id/.test(CHAT_CTRL) &&
       /emitToUser\(chatroom\.publisher\.id/.test(CHAT_CTRL),
  'per-user emitToUser calls retained (chat list works for participants)');

out('\n=== Gap 4 — cart BroadcastChannel multi-tab sync ===');
assert(/new BroadcastChannel\(['"]serpbays-cart['"]\)/.test(C_CART),
  'BroadcastChannel constructed with stable name');
assert(/export function notifyCartChanged/.test(C_CART),
  'notifyCartChanged() exported');
assert(/event\?\.data === ['"]cart:changed['"]/.test(C_CART) &&
       /syncWithServer\(\)/.test(C_CART),
  'receiver re-syncs from server on cart:changed');
// At minimum, addItem + removeItem + clearCart should fire it
assert((C_CART.match(/notifyCartChanged\(\)/g) || []).length >= 3,
  'notifyCartChanged called from multiple mutation sites');

out('\n=== Gap 5 — admin:permissions_changed (per-user) ===');
assert(/emitToUser\(id,\s*['"]admin:permissions_changed['"]/.test(ADMIN_MGMT),
  'updateAdminPermissions emits to TARGET user only (not admins room)');
assert(/targetUserId/.test(ADMIN_MGMT),
  'payload carries targetUserId');

out('\n=== Client: websocketService — WUR event ===');
assert(/export\s+interface\s+WebsiteUpdateRequestStatusEvent/.test(C_WS),
  'WebsiteUpdateRequestStatusEvent type exported');
assert(/onWebsiteUpdateRequestUpdate\s*\(\s*handler/.test(C_WS),
  'onWebsiteUpdateRequestUpdate registration API exposed');
assert(/this\.socket\.on\(\s*['"]website_update_request:status_changed['"]/.test(C_WS),
  'socket.on listener for website_update_request:status_changed');
assert(/event\.seq\s*<=\s*this\.lastWurSeq/.test(C_WS),
  'WUR events use seq dedup');

out('\n=== Client: my-websites subscribes ===');
assert(/websocketService\.onWebsiteUpdateRequestUpdate\(/.test(C_MW),
  'my-websites page subscribes via onWebsiteUpdateRequestUpdate');
assert(/invalidateQueries\(\{\s*queryKey:\s*\[['"]publisherWebsites['"]/.test(C_MW),
  'handler invalidates publisherWebsites query');

out('\n=== Panel20: 4 new event types + handlers ===');
assert(/export\s+interface\s+AdminWebsiteUpdateEvent/.test(P_WS),
  'AdminWebsiteUpdateEvent type exported');
assert(/export\s+interface\s+AdminChatEvent/.test(P_WS),
  'AdminChatEvent type exported');
assert(/export\s+interface\s+AdminMarketplaceEvent/.test(P_WS),
  'AdminMarketplaceEvent type exported');
assert(/export\s+interface\s+AdminPermissionsChangedEvent/.test(P_WS),
  'AdminPermissionsChangedEvent type exported');
assert(/onWebsiteUpdateEvent\s*\(/.test(P_WS) &&
       /onChatEvent\s*\(/.test(P_WS) &&
       /onMarketplaceEvent\s*\(/.test(P_WS) &&
       /onPermissionsChanged\s*\(/.test(P_WS),
  'all 4 registration APIs exposed');
assert(/this\.socket\.on\(\s*['"]admin:website_update_event['"]/.test(P_WS) &&
       /this\.socket\.on\(\s*['"]admin:chat_event['"]/.test(P_WS) &&
       /this\.socket\.on\(\s*['"]admin:marketplace_event['"]/.test(P_WS) &&
       /this\.socket\.on\(\s*['"]admin:permissions_changed['"]/.test(P_WS),
  'all 4 socket.on listeners installed');

out('\n=== Panel20: hook + page subscribers ===');
assert(/adminWebsocketService\.onPermissionsChanged\(\(\)\s*=>\s*\{[\s\S]{0,200}update\(\)/.test(P_HOOK),
  'use-admin-websocket hook calls next-auth update() on permissions change');
assert(/adminWebsocketService\.onWebsiteUpdateEvent\(/.test(P_WU),
  '/website-updates page subscribes to onWebsiteUpdateEvent');
assert(/adminWebsocketService\.onMarketplaceEvent\(/.test(P_MP),
  'use-marketplace hook subscribes to onMarketplaceEvent');
assert(/adminWebsocketService\.onChatEvent\(/.test(P_COMM),
  'use-admin-communications hook subscribes to onChatEvent');

out('\n=== Debounce safety on all new admin subscribers ===');
assert(/setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,300}invalidateQueries[\s\S]{0,300}queryKeys\.marketplace/.test(P_MP),
  'marketplace hook debounces invalidation');
assert(/setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,300}invalidateQueries[\s\S]{0,300}communications/.test(P_COMM),
  'communications hook debounces invalidation');
assert(/setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,200}load\(\)/.test(P_WU),
  '/website-updates page debounces reload');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
