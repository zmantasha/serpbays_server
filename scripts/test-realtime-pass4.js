#!/usr/bin/env node
/**
 * Regression test — real-time wiring pass 4.
 *
 * Extends real-time coverage to:
 *
 *   SERVER
 *   - src/api/withdrawal-request/services/withdrawal-request.js
 *       NEW emitWithdrawalStatusChanged service helper (per-user seq).
 *   - src/api/withdrawal-request/content-types/withdrawal-request/lifecycles.js
 *       afterCreate + amend afterUpdate to call the helper after the
 *       existing handler dispatch.
 *   - src/api/bank-transfer-request/services/bank-transfer-request.js
 *       NEW core service + emitBankTransferStatusChanged helper.
 *   - src/api/bank-transfer-request/content-types/bank-transfer-request/lifecycles.js
 *       NEW lifecycle — afterCreate + afterUpdate (gated on params.data.status).
 *
 *   CLIENT
 *   - lib/services/websocketService.ts
 *       WithdrawalStatusEvent + BankTransferStatusEvent interfaces;
 *       onWithdrawalUpdate / onBankTransferUpdate handler-registration APIs;
 *       socket.on('withdrawal:status_changed') + socket.on('bank_transfer:status_changed')
 *       with per-channel seq dedup mirroring wallet/order.
 *   - components/wallet/WithdrawalHistory.tsx
 *       Subscribes to onWithdrawalUpdate; refetches page 1 on any
 *       transition.
 *
 *   ORDER UI INTEGRATION (pass-3 follow-through):
 *   - usePublisherOrders / useAdvertiserOrders hooks invalidate React
 *     Query keys via onOrderUpdate (side-gated).
 *   - layout.tsx wires onOrderUpdate → updateCounts (publisher only).
 *   - orders/order-detail + publisher/order-detail subscribe per-orderId.
 *   - dashboard.tsx invalidates myOrders + availableOrders +
 *     publisherBalance on the matching events.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-realtime-pass4.js
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
const WR_SVC = read('src/api/withdrawal-request/services/withdrawal-request.js');
const WR_LC  = read('src/api/withdrawal-request/content-types/withdrawal-request/lifecycles.js');
const BTR_SVC = read('src/api/bank-transfer-request/services/bank-transfer-request.js');
const BTR_LC  = read('src/api/bank-transfer-request/content-types/bank-transfer-request/lifecycles.js');

// Client
const CLIENT = (rel) => read(`/var/www/serpbays/serpbays_client/${rel}`);
const C_WS    = CLIENT('lib/services/websocketService.ts');
const C_WHIST = CLIENT('components/wallet/WithdrawalHistory.tsx');
const C_PUB   = CLIENT('app/(dashboard)/publisher/my-orders/hooks/usePublisherOrders.ts');
const C_ADV   = CLIENT('app/(dashboard)/orders/hooks/useAdvertiserOrders.ts');
const C_LAY   = CLIENT('app/(dashboard)/layout.tsx');
const C_ADET  = CLIENT('app/(dashboard)/orders/order-detail/[id]/page.tsx');
const C_PDET  = CLIENT('app/(dashboard)/publisher/order-detail/[id]/page.tsx');
const C_DASH  = CLIENT('app/(dashboard)/dashboard/page.tsx');

out('\n=== 1) Server: withdrawal-request service + lifecycle ===');
assert(/withdrawalSeqByUser\s*=\s*new\s+Map\(\)/.test(WR_SVC),
  'per-user withdrawal seq Map declared');
assert(/async\s+emitWithdrawalStatusChanged\s*\(/.test(WR_SVC),
  'emitWithdrawalStatusChanged service method defined');
assert(/strapi\.io\.emitToUser\(\s*publisherId,\s*['"]withdrawal:status_changed['"]/.test(WR_SVC),
  'emits on publisher channel with withdrawal:status_changed');
assert(/async\s+afterCreate/.test(WR_LC) &&
  /emitWithdrawalStatusChanged/.test(WR_LC),
  'lifecycle afterCreate calls emit helper');
assert(/state\.statusChanged[\s\S]{0,1500}emitWithdrawalStatusChanged/.test(WR_LC),
  'afterUpdate emit is gated on state.statusChanged (no spam on note-only edits)');

out('\n=== 2) Server: bank-transfer-request service + lifecycle (NEW) ===');
assert(/btrSeqByUser\s*=\s*new\s+Map\(\)/.test(BTR_SVC),
  'per-user bank-transfer seq Map declared');
assert(/async\s+emitBankTransferStatusChanged\s*\(/.test(BTR_SVC),
  'emitBankTransferStatusChanged service method defined');
assert(/strapi\.io\.emitToUser\(\s*targetUserId,\s*['"]bank_transfer:status_changed['"]/.test(BTR_SVC),
  'emits on requester channel with bank_transfer:status_changed');
assert(/async\s+afterCreate/.test(BTR_LC) &&
  /emitBankTransferStatusChanged/.test(BTR_LC),
  'lifecycle afterCreate calls emit helper');
assert(/params\.data[\s\S]{0,80}['"]status['"][\s\S]{0,200}emitBankTransferStatusChanged/.test(BTR_LC),
  'afterUpdate emit is gated on params.data.status');

out('\n=== 3) Client: websocketService — withdrawal + bank-transfer channels ===');
assert(/export\s+interface\s+WithdrawalStatusEvent/.test(C_WS),
  'WithdrawalStatusEvent type exported');
assert(/export\s+interface\s+BankTransferStatusEvent/.test(C_WS),
  'BankTransferStatusEvent type exported');
assert(/onWithdrawalUpdate\(handler:\s*WithdrawalHandler\)/.test(C_WS),
  'onWithdrawalUpdate registration API exposed');
assert(/onBankTransferUpdate\(handler:\s*BankTransferHandler\)/.test(C_WS),
  'onBankTransferUpdate registration API exposed');
assert(/this\.socket\.on\(\s*['"]withdrawal:status_changed['"]/.test(C_WS),
  'client subscribes to withdrawal:status_changed channel');
assert(/this\.socket\.on\(\s*['"]bank_transfer:status_changed['"]/.test(C_WS),
  'client subscribes to bank_transfer:status_changed channel');
assert(/event\.seq\s*<=\s*this\.lastWithdrawalSeq/.test(C_WS) &&
  /event\.seq\s*<=\s*this\.lastBankTransferSeq/.test(C_WS),
  'per-channel seq dedup');

out('\n=== 4) Client: WithdrawalHistory subscribes ===');
assert(/onWithdrawalUpdate\(\(\)\s*=>/.test(C_WHIST),
  'WithdrawalHistory registers onWithdrawalUpdate handler');
assert(/setWithdrawalCurrentPage\(1\)/.test(C_WHIST),
  'handler resets to page 1 (status flip bubbles to top)');

out('\n=== 5) Client: order list/detail hooks subscribe to onOrderUpdate ===');
assert(/onOrderUpdate\([\s\S]{0,200}event\.side\s*!==\s*['"]publisher['"]/.test(C_PUB),
  'publisher list hook side-gates on publisher events');
assert(/invalidateQueries\(\{\s*queryKey:\s*\[['"]publisherOrders['"]\]/.test(C_PUB),
  'publisher list hook invalidates publisherOrders');
assert(/onOrderUpdate\([\s\S]{0,200}event\.side\s*!==\s*['"]advertiser['"]/.test(C_ADV),
  'advertiser list hook side-gates on advertiser events');
assert(/invalidateQueries\(\{\s*queryKey:\s*\[['"]advertiserOrders['"]\]/.test(C_ADV),
  'advertiser list hook invalidates advertiserOrders');

out('\n=== 6) Client: layout updateCounts wired to onOrderUpdate ===');
assert(/onOrderUpdate\(\(\)\s*=>\s*\{\s*updateCounts\(\)/.test(C_LAY),
  'layout drops the 30s polling lag — WS-driven updateCounts');

out('\n=== 7) Client: order-detail pages refetch on matching orderId ===');
for (const [name, body] of [['advertiser', C_ADET], ['publisher', C_PDET]]) {
  assert(/onOrderUpdate\([\s\S]{0,400}event\.orderId\s*!==\s*orderId/.test(body),
    `${name} order-detail filters on event.orderId === orderId`);
}

out('\n=== 8) Client: dashboard invalidates relevant queries ===');
assert(/onOrderUpdate\([\s\S]{0,300}invalidateQueries\(\{\s*queryKey:\s*\[['"]myOrders['"]\]/.test(C_DASH),
  'dashboard invalidates myOrders on order events');
assert(/onWalletUpdate\([\s\S]{0,200}invalidateQueries\(\{\s*queryKey:\s*\[['"]publisherBalance['"]\]/.test(C_DASH),
  'dashboard invalidates publisherBalance on wallet events');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
