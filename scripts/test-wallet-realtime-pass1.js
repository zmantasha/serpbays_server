#!/usr/bin/env node
/**
 * Regression test — wallet real-time wiring (pass 1).
 *
 * Closes:
 *   - Multi-socket-per-user Map overwrite (only the latest tab received events)
 *   - JWT userId-vs-query mismatch (could let A connect with A's JWT but join
 *     B's room and receive B's events)
 *   - emitToUser now routes via Socket.IO rooms (multi-tab + multi-device)
 *   - Wallet has NO event emission today → adds emitBalanceUpdate service +
 *     hooks into addMainFunds / addPromoFunds / spendFunds / completeOrder /
 *     refundEscrowToAdvertiser / withdrawal create / withdrawal deny refund
 *   - Client store has shape mismatch (only persisted balance + escrow but
 *     not mainBalance/promoBalance/pendingWithdrawal) → new shape with
 *     applyWalletEvent + setFromRest + seq-dedup
 *   - Client polling pattern (CustomEvent fan-out + fetchBalance) → real-time
 *     WS push + reconnect REST reconciliation
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-wallet-realtime-pass1.js
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

const WS_BOOT  = read('src/bootstrap/websocket.js');
const UW_SVC   = read('src/api/user-wallet/services/user-wallet.js');
const UW_CTRL  = read('src/api/user-wallet/controllers/user-wallet.js');
const ORDER    = read('src/api/order/services/order.js');
const WR_CTRL  = read('src/api/withdrawal-request/controllers/withdrawal-request.js');

const CLIENT_WS = read('/var/www/serpbays/serpbays_client/lib/services/websocketService.ts');
const CLIENT_STORE = read('/var/www/serpbays/serpbays_client/lib/store/wallet.ts');
const CLIENT_SVC   = read('/var/www/serpbays/serpbays_client/lib/services/walletService.ts');

out('\n=== 1) Server: WebSocket multi-tab + JWT-id-match hardening ===');
assert(/connectedUsers\s*=\s*new Map\(\);\s*\/\/\s*userId.*Set<socket/.test(WS_BOOT) ||
  /trackUserSocket\s*=\s*\(userId,\s*socket\)/.test(WS_BOOT),
  'connectedUsers Map now keyed userId → Set<socket.id> (multi-tab safe)');
assert(/io\.to\(`user_\$\{uid\}`\)\.emit\(/.test(WS_BOOT),
  'emitToUser routes via room (io.to(...)) — every socket the user has, not just the last one');
assert(/Number\.parseInt\(userId,\s*10\)\s*!==\s*Number\.parseInt\(decoded\.id,\s*10\)/.test(WS_BOOT),
  'JWT userId-vs-query mismatch rejected at connect time');

out('\n=== 2) Server: wallet emitBalanceUpdate service ===');
assert(/async\s+emitBalanceUpdate\s*\(\s*userId\s*,\s*reason/.test(UW_SVC),
  'emitBalanceUpdate service method defined');
assert(/strapi\.io\.emitToUser\s*\(\s*uid\s*,\s*['"]wallet:balance_updated['"]/.test(UW_SVC),
  'emits on the wallet:balance_updated channel');
// Per-user monotonic sequence numbers (so clients drop stale events).
// Pass 7 centralized seq into utils/realtime-seq so any of these shapes pass:
//   - legacy in-place Map (pre-pass-7)
//   - require('.../realtime-seq')('wallet') factory call (post-pass-7)
//   - seq.next(uid) call site (post-pass-7)
assert(/seqByUser\s*=\s*new\s+Map\(\)|nextSeq\s*=\s*\(userId\)\s*=>|require\(['"][^'"]*realtime-seq['"]\)\(['"]wallet['"]\)|seq\.next\(\s*uid\s*\)/.test(UW_SVC),
  'per-user monotonic seq numbers (out-of-order safety)');
// Payload includes balance breakdown
assert(/balance:\s*\{\s*main,\s*promo,\s*escrow,\s*total,\s*pendingWithdrawal\s*\}/.test(UW_SVC),
  'payload carries main / promo / escrow / total / pendingWithdrawal');

out('\n=== 3) Server: internal helpers emit on every mutation ===');
for (const helper of ['addMainFunds', 'addPromoFunds', 'spendFunds']) {
  const helperStart = UW_CTRL.indexOf(`async ${helper}(`);
  const helperEnd = UW_CTRL.indexOf('async ', helperStart + 1);
  const body = helperStart > 0 && helperEnd > helperStart ? UW_CTRL.slice(helperStart, helperEnd) : '';
  assert(/emitBalanceUpdate\s*\(/.test(body),
    `${helper} calls emitBalanceUpdate after the DB write`);
}

out('\n=== 4) Server: order completion + refund emit ===');
// completeOrder emits BOTH sides after the transaction commits
const coStart = ORDER.indexOf('async completeOrder(');
const coEnd = ORDER.indexOf('async rejectOrder(');
const co = coStart > 0 && coEnd > coStart ? ORDER.slice(coStart, coEnd) : '';
assert(co.length > 0, 'completeOrder body sliced');
assert(/(?:walletSvc|walletService)\.emitBalanceUpdate\(\s*advertiserIdForEvent,\s*['"]order_completion['"]/.test(co),
  'completeOrder emits to advertiser after commit');
assert(/(?:walletSvc|walletService)\.emitBalanceUpdate\(\s*publisherIdForEvent,\s*['"]order_completion['"]/.test(co),
  'completeOrder emits to publisher after commit');
// refundEscrowToAdvertiser emits the refund
assert(/emitBalanceUpdate\(\s*\n?\s*order\.advertiser\.id,\s*["']order_cancellation["']/.test(ORDER) ||
  /emitBalanceUpdate\s*\(\s*[\s\S]{0,80}order\.advertiser\.id\s*,\s*["']order_cancellation["']/.test(ORDER),
  'refundEscrowToAdvertiser emits on the advertiser channel');

out('\n=== 5) Server: withdrawal create + deny refund emit ===');
const wrCreateStart = WR_CTRL.indexOf('async create(');
const wrCreateEnd = WR_CTRL.indexOf('async getMyWithdrawals(');
const wrCreate = wrCreateStart > 0 && wrCreateEnd > wrCreateStart ? WR_CTRL.slice(wrCreateStart, wrCreateEnd) : '';
assert(/emitBalanceUpdate\(\s*\n?\s*userId,\s*["']withdrawal_pending["']/.test(wrCreate) ||
  /emitBalanceUpdate\s*\([\s\S]{0,80}["']withdrawal_pending["']/.test(wrCreate),
  'withdrawal create emits withdrawal_pending after wallet debit');
const wrDenyStart = WR_CTRL.indexOf('async denyWithdrawal(');
const wrDenyEnd = WR_CTRL.indexOf('async markAsPaidWithdrawal(');
const wrDeny = wrDenyStart > 0 && wrDenyEnd > wrDenyStart ? WR_CTRL.slice(wrDenyStart, wrDenyEnd) : '';
assert(/emitBalanceUpdate[\s\S]{0,200}["']withdrawal_refund["']/.test(wrDeny),
  'denyWithdrawal emits withdrawal_refund after wallet restore');

out('\n=== 6) Client: WebSocket service handles wallet:balance_updated ===');
assert(/this\.socket\.on\(\s*['"]wallet:balance_updated['"]/.test(CLIENT_WS),
  'client subscribes to wallet:balance_updated channel');
assert(/lastWalletSeq/.test(CLIENT_WS) && /event\.seq\s*<=\s*this\.lastWalletSeq/.test(CLIENT_WS),
  'client drops out-of-order events via seq comparison');
assert(/export\s+interface\s+WalletBalanceEvent/.test(CLIENT_WS),
  'WalletBalanceEvent type exported (TypeScript safety)');
assert(/onWalletUpdate\(handler:\s*WalletHandler\)/.test(CLIENT_WS),
  'onWalletUpdate handler-registration API exposed');
assert(/isConnected\(\):\s*boolean/.test(CLIENT_WS),
  'isConnected() exposed (callers can decide whether to REST-resync)');

out('\n=== 7) Client: wallet store has setFromRest + applyWalletEvent + seq guard ===');
assert(/setFromRest:\s*\(snapshot/.test(CLIENT_STORE),
  'setFromRest accepts a REST snapshot');
assert(/applyWalletEvent:\s*\(event/.test(CLIENT_STORE),
  'applyWalletEvent accepts a WS event payload');
assert(/event\.seq\s*<=\s*state\.lastSeq/.test(CLIENT_STORE),
  'applyWalletEvent drops out-of-order events (defense in depth + WS-service guard)');
assert(/mainBalance:\s*number/.test(CLIENT_STORE) && /promoBalance:\s*number/.test(CLIENT_STORE) &&
  /pendingWithdrawalBalance:\s*number/.test(CLIENT_STORE),
  'store carries all 5 balance fields (was: only balance + escrow)');

out('\n=== 8) Client: walletService registers the WS → store bridge on import ===');
assert(/registerWalletEventBridge\s*\(\)/.test(CLIENT_SVC),
  'registerWalletEventBridge() invoked at module load');
assert(/websocketService\.onWalletUpdate\(\s*\(event\)\s*=>/.test(CLIENT_SVC),
  'bridge subscribes via websocketService.onWalletUpdate');
assert(/useWalletStore\.getState\(\)\.applyWalletEvent\(event\)/.test(CLIENT_SVC),
  'bridge routes events directly into the Zustand store');
assert(/document\.addEventListener\('visibilitychange'/.test(CLIENT_SVC),
  'visibilitychange listener triggers REST resync on tab-return');

out('\n=== 9) Client: REST fetch uses canonical setFromRest (not raw setState) ===');
assert(/useWalletStore\.getState\(\)\.setFromRest\(\{\s*balance,\s*mainBalance/.test(CLIENT_SVC),
  'fetchBalance() routes through setFromRest (all 5 fields stay in lockstep)');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
