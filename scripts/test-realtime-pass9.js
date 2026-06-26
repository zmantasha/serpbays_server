#!/usr/bin/env node
/**
 * Regression test — real-time wiring pass 9 (final audit gaps).
 *
 * The final end-to-end audit (post-pass-8) surfaced 3 list-view gaps
 * where the underlying data was being mutated and emitted live but the
 * paginated list itself wasn't subscribed:
 *
 *   Gap 1: /wallet page's transaction list
 *     — balance pill updated via the store, but the tx history table
 *       only refetched on mount, after PayPal popup completion, and on
 *       manual pagination. An admin credit landed in the wallet
 *       balance instantly but the matching row didn't appear in the
 *       list until refresh.
 *
 *   Gap 2: /transactions admin page
 *     — 2-minute staleTime, no realtime invalidation. Every wallet
 *       mutation creates a transaction row server-side, so the wallet
 *       channel is the canonical "tx list changed" signal.
 *
 *   Gap 3: /orders admin page
 *     — 2-minute staleTime, no realtime invalidation on order:status
 *       changes.
 *
 * Gaps 4 (admin communications) and 5 (marketplace/website stats) were
 * explicitly deferred by the audit — they require new server channels
 * (admin:communication_event, website:status_changed) and the audit
 * recommended deferring until ops asks.
 *
 * Run: cd serpbays_server && node scripts/test-realtime-pass9.js
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

const CLIENT = (rel) => read(`/var/www/serpbays/serpbays_client/${rel}`);
const PANEL20 = (rel) => read(`/var/www/serpbays-adminpanel/serpbays_admin/${rel}`);

const C_WAL = CLIENT('app/(dashboard)/wallet/page.tsx');
const P_TX = PANEL20('src/lib/hooks/use-admin-transactions.ts');
const P_ORD = PANEL20('src/lib/hooks/use-admin-orders.ts');

out('\n=== Gap 1: /wallet transaction list — onWalletUpdate refetch ===');
assert(/import\s*\{\s*websocketService\s*\}\s*from\s*['"]@\/lib\/services\/websocketService['"]/.test(C_WAL),
  'wallet page imports websocketService');
assert(/websocketService\.onWalletUpdate\(\(\)\s*=>/.test(C_WAL),
  '/wallet subscribes via onWalletUpdate');
assert(/fetchTransactions\(transactionsPage,\s*transactionsPageSize\)/.test(C_WAL) &&
       /transactionsPage === 1/.test(C_WAL),
  'handler refetches the current page only when on page 1 (preserve pagination)');
assert(/setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,200}fetchTransactions/.test(C_WAL),
  'handler is debounced to coalesce burst events');

out('\n=== Gap 2: admin /transactions — onWalletEvent invalidation ===');
assert(/import\s*\{\s*adminWebsocketService\s*\}\s*from\s*['"]@\/lib\/services\/adminWebsocketService['"]/.test(P_TX),
  'transactions hook imports adminWebsocketService');
assert(/adminWebsocketService\.onWalletEvent\(\(\)\s*=>/.test(P_TX),
  'transactions hook subscribes via onWalletEvent');
assert(/invalidateQueries\(\{\s*queryKey:\s*\[['"]transactions['"],\s*['"]list['"]\]\s*\}\)/.test(P_TX),
  'handler invalidates [transactions, list] query key');

out('\n=== Gap 3: admin /orders — onOrderEvent invalidation ===');
assert(/import\s*\{\s*adminWebsocketService\s*\}\s*from\s*['"]@\/lib\/services\/adminWebsocketService['"]/.test(P_ORD),
  'orders hook imports adminWebsocketService');
assert(/adminWebsocketService\.onOrderEvent\(\(\)\s*=>/.test(P_ORD),
  'orders hook subscribes via onOrderEvent');
assert(/invalidateQueries\(\{\s*queryKey:\s*queryKeys\.orders\.lists\(\)\s*\}\)/.test(P_ORD),
  'handler invalidates queryKeys.orders.lists()');
assert(/invalidateQueries\(\{\s*queryKey:\s*queryKeys\.orders\.stats\(\)\s*\}\)/.test(P_ORD),
  'handler also invalidates queryKeys.orders.stats()');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
