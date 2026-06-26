#!/usr/bin/env node
/**
 * Regression test — real-time wiring pass 3.
 *
 * Closes the gaps the wallet-render audit surfaced + extends real-time to
 * the orders module:
 *
 *   CLIENT wallet renders
 *   - components/wallet/wallet-balance.tsx       → dead CustomEvent listener
 *                                                  removed; mount-only fetch
 *                                                  backstop; store subscription
 *                                                  is the re-render driver.
 *   - app/(dashboard)/layout.tsx                 → redundant wallet-balance-update
 *                                                  listener removed; cold-load
 *                                                  fetch still present.
 *   - lib/hooks/useWallet.ts                     → returns all 5 balance fields
 *                                                  (was missing main/promo/pending).
 *   - app/(dashboard)/wallet/page.tsx            → WalletBalanceCard +
 *                                                  TransactionHistory read
 *                                                  balance/escrow from the store,
 *                                                  not the local walletData snapshot.
 *   - publisher/earnings/page.tsx                → onWalletUpdate-driven refetch
 *                                                  replaces the synchronizeBalance()
 *                                                  CustomEvent dead-fan-out.
 *
 *   SERVER orders wiring
 *   - src/api/order/services/order.js            → emitOrderUpdate helper +
 *                                                  per-user monotonic seq.
 *   - src/api/order/content-types/order/lifecycles.js (NEW)
 *                                                → afterCreate + afterUpdate
 *                                                  chokepoint covering every
 *                                                  orderStatus transition.
 *
 *   CLIENT orders wiring
 *   - lib/services/websocketService.ts           → OrderStatusEvent type +
 *                                                  onOrderUpdate(handler) +
 *                                                  socket.on('order:status_changed')
 *                                                  with seq dedup.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-realtime-pass3.js
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
const ORDER_SVC = read('src/api/order/services/order.js');
const ORDER_LC  = read('src/api/order/content-types/order/lifecycles.js');

// Client
const CLIENT = (rel) => read(`/var/www/serpbays/serpbays_client/${rel}`);
const C_WB   = CLIENT('components/wallet/wallet-balance.tsx');
const C_LAY  = CLIENT('app/(dashboard)/layout.tsx');
const C_HK   = CLIENT('lib/hooks/useWallet.ts');
const C_WP   = CLIENT('app/(dashboard)/wallet/page.tsx');
const C_EARN = CLIENT('app/(dashboard)/publisher/earnings/page.tsx');
const C_WS   = CLIENT('lib/services/websocketService.ts');

out('\n=== 1) Client: wallet-balance.tsx dead listener removed ===');
assert(!/window\.addEventListener\(\s*['"]wallet-balance-update['"]/.test(C_WB),
  'wallet-balance-update CustomEvent listener removed');
assert(!/addEventListener\(\s*['"]visibilitychange['"]/.test(C_WB),
  'visibilitychange handler removed (walletService bridge handles it)');
assert(/useWalletStore\(\(s\)\s*=>\s*s\.balance\)/.test(C_WB),
  'store-selector subscription (s => s.balance)');
assert(/walletBalanceEvents/.test(C_WB) && /no-op/.test(C_WB),
  'walletBalanceEvents export kept as no-op shim (BC for stragglers)');

out('\n=== 2) Client: layout.tsx redundant listener removed ===');
assert(!/window\.addEventListener\(\s*['"]wallet-balance-update['"]/.test(C_LAY),
  'layout.tsx no longer listens for wallet-balance-update');
assert(/useWalletStore\(\(state\)\s*=>\s*state\.balance\)/.test(C_LAY),
  'navbar reads balance from useWalletStore (Zustand reactivity)');
assert(/walletService\.fetchBalance\(\)/.test(C_LAY),
  'cold-load fetchBalance backstop preserved');

out('\n=== 3) Client: useWallet hook surfaces all 5 balance fields ===');
{
  // grep the destructured set from the store + the return object
  assert(/mainBalance,/.test(C_HK) && /promoBalance,/.test(C_HK) &&
         /pendingWithdrawalBalance/.test(C_HK),
    'destructures main / promo / pendingWithdrawal from store');
  const returnIdx = C_HK.lastIndexOf('return {');
  const tail = returnIdx > 0 ? C_HK.slice(returnIdx) : '';
  assert(/mainBalance,/.test(tail) && /promoBalance,/.test(tail) &&
         /pendingWithdrawalBalance,/.test(tail),
    'returns all 5 balance fields (was: only balance + escrowBalance)');
}

out('\n=== 4) Client: wallet/page.tsx reads from store, not local snapshot ===');
assert(/<WalletBalanceCard[\s\S]{0,200}balance=\{balance\}\s*\n\s*escrowBalance=\{escrowBalance\}/.test(C_WP),
  'WalletBalanceCard receives store balance + escrow (not walletData.*)');
assert(/currentBalance=\{balance\}/.test(C_WP),
  'TransactionHistory currentBalance reads from store');

out('\n=== 5) Client: publisher/earnings/page.tsx WS-driven refetch ===');
assert(/onWalletUpdate\(\(\)\s*=>/.test(C_EARN),
  'earnings page registers a websocketService.onWalletUpdate handler');
assert(/loadInitialData\(\)/.test(C_EARN),
  'handler triggers loadInitialData() refetch');
assert(!/walletBalanceEvents\.synchronizeBalance\(\);/.test(C_EARN),
  'dead synchronizeBalance() call removed from loadInitialData');
assert(!/import\s*\{\s*walletBalanceEvents/.test(C_EARN),
  'unused walletBalanceEvents import removed');

out('\n=== 6) Server: order emitOrderUpdate helper + seq ===');
// Pass 7 moved seq into utils/realtime-seq; either the legacy Map or the
// new factory import qualifies.
assert(/orderSeqByUser\s*=\s*new\s+Map\(\)|require\(['"][^'"]*realtime-seq['"]\)\(['"]order['"]\)/.test(ORDER_SVC),
  'per-user order seq (Map pre-pass-7, realtime-seq factory post-pass-7)');
assert(/async\s+emitOrderUpdate\s*\(\s*orderOrId/.test(ORDER_SVC),
  'emitOrderUpdate service method defined');
assert(/strapi\.io\.emitToUser\(\s*advertiserId,\s*['"]order:status_changed['"]/.test(ORDER_SVC),
  'emits on advertiser channel with order:status_changed');
assert(/strapi\.io\.emitToUser\(\s*publisherId,\s*['"]order:status_changed['"]/.test(ORDER_SVC),
  'emits on publisher channel with order:status_changed');
assert(/side:\s*['"]advertiser['"]/.test(ORDER_SVC) && /side:\s*['"]publisher['"]/.test(ORDER_SVC),
  'payload carries side so client knows which list to refetch');

out('\n=== 7) Server: order lifecycle wires the helper ===');
assert(/afterCreate/.test(ORDER_LC) && /emitOrderUpdate/.test(ORDER_LC),
  'afterCreate calls emitOrderUpdate');
assert(/afterUpdate/.test(ORDER_LC) &&
       /params\.data[\s\S]{0,80}orderStatus/.test(ORDER_LC),
  'afterUpdate only emits when orderStatus is in params.data');

out('\n=== 8) Client: websocketService onOrderUpdate + listener ===');
assert(/export\s+interface\s+OrderStatusEvent/.test(C_WS),
  'OrderStatusEvent type exported');
assert(/onOrderUpdate\(handler:\s*OrderHandler\)/.test(C_WS),
  'onOrderUpdate registration API exposed');
assert(/this\.socket\.on\(\s*['"]order:status_changed['"]/.test(C_WS),
  'client subscribes to order:status_changed channel');
assert(/event\.seq\s*<=\s*this\.lastOrderSeq/.test(C_WS),
  'order events use seq dedup just like wallet');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
