#!/usr/bin/env node
/**
 * Regression test — perf pass 10 (performance audit fixes).
 *
 * Validates the code-level changes that the 4-fork performance audit
 * surfaced. Real load metrics (request latency, concurrent throughput)
 * have to come from staging — these assertions confirm the code is in
 * place for those wins to materialize once deployed.
 *
 * Run: cd serpbays_server && node scripts/test-perf-pass10.js
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

const MIDDLE = read('config/middlewares.js');
const ENV_EX = read('.env.example');
const PROJ_CTRL = read('src/api/project/controllers/project.js');
const CHAT_CTRL = read('src/api/chatroom/controllers/chatroom.js');

const CLIENT_NEXT = read('/var/www/serpbays/serpbays_client/next.config.js');
const C_DASH = read('/var/www/serpbays/serpbays_client/app/(dashboard)/dashboard/page.tsx');
const C_CART = read('/var/www/serpbays/serpbays_client/app/(dashboard)/cart/checkout/page.tsx');

const P_TX = read('/var/www/serpbays-adminpanel/serpbays_admin/src/lib/hooks/use-admin-transactions.ts');
const P_ORD = read('/var/www/serpbays-adminpanel/serpbays_admin/src/lib/hooks/use-admin-orders.ts');
const P_WIT = read('/var/www/serpbays-adminpanel/serpbays_admin/src/lib/hooks/use-admin-withdrawals.ts');
const P_DASH = read('/var/www/serpbays-adminpanel/serpbays_admin/src/lib/hooks/use-admin-dashboard.ts');
const P_USER = read('/var/www/serpbays-adminpanel/serpbays_admin/src/app/users/[id]/page.tsx');
const P_MODAL = read('/var/www/serpbays-adminpanel/serpbays_admin/src/components/AddTransactionModal.tsx');
const P_PROV = read('/var/www/serpbays-adminpanel/serpbays_admin/src/app/providers.tsx');

out('\n=== 10A: DB indexes ===');
// Migration files exist (actual index presence verified at DB level)
assert(fs.existsSync('database/migrations/2026.06.23T00.00.00.add-hot-query-indexes.js'),
  'index migration #1 exists');
assert(fs.existsSync('database/migrations/2026.06.23T00.00.01.fix-marketplaces-status-index.js'),
  'marketplaces status fix migration exists');
assert(fs.existsSync('database/migrations/2026.06.23T00.00.02.add-hot-query-indexes-retry.js'),
  'retry migration (recreates 7 indexes after tx-rollback) exists');

out('\n=== 10B: Server config ===');
assert(/['"]strapi::compression['"]/.test(MIDDLE),
  'strapi::compression middleware added');
assert(/DATABASE_POOL_MAX/.test(ENV_EX),
  '.env.example documents DATABASE_POOL_MAX');
assert(/REDIS_URL/.test(ENV_EX),
  '.env.example documents REDIS_URL');
// Strip line comments before matching so the "was populate:'*'" comment
// I added during the fix doesn't false-positive.
{
  const stripped = PROJ_CTRL.replace(/\/\/.*$/gm, '');
  assert(!/populate:\s*['"]\*['"]/.test(stripped),
    "project controller no longer uses populate: '*'");
}
assert(/fields:\s*\['description'/.test(PROJ_CTRL),
  'project controller uses explicit fields populate');

out('\n=== 10C: Chatroom broadcast → emitToUser ===');
assert(!/strapi\.io\.emit\(`user_\$\{chatroom\./.test(CHAT_CTRL),
  'chatroom no longer uses strapi.io.emit() (broadcast)');
assert(/strapi\.io\.emitToUser\(chatroom\.advertiser\.id/.test(CHAT_CTRL),
  'chatroom advertiser emit uses emitToUser (room-based)');
assert(/strapi\.io\.emitToUser\(chatroom\.publisher\.id/.test(CHAT_CTRL),
  'chatroom publisher emit uses emitToUser');

out('\n=== 10D: next.config.js ===');
assert(/Cache-Control[\s\S]{0,100}public,\s*max-age=31536000,\s*immutable/.test(CLIENT_NEXT),
  'static asset cache header is immutable (was: no-store — THE biggest perf bug)');
assert(/swcMinify:\s*true/.test(CLIENT_NEXT),
  'swcMinify enabled');
assert(/compress:\s*true/.test(CLIENT_NEXT),
  'Next.js compression enabled');
assert(/poweredByHeader:\s*false/.test(CLIENT_NEXT),
  'X-Powered-By header disabled');
assert(/optimizePackageImports:\s*\[[\s\S]{0,200}lucide-react/.test(CLIENT_NEXT),
  'optimizePackageImports configured for lucide-react');

out('\n=== 10E: Client store selectors + dead-file cleanup ===');
assert(/useWalletStore\(\(s\)\s*=>\s*s\.balance\)/.test(C_DASH),
  'dashboard uses selector form');
assert(/useWalletStore\(\(s\)\s*=>\s*s\.balance\)/.test(C_CART),
  'checkout uses selector form');
assert(!fs.existsSync('/var/www/serpbays/serpbays_client/app/(dashboard)/wallet/page.old.tsx'),
  'wallet/page.old.tsx deleted');
assert(!fs.existsSync('/var/www/serpbays/serpbays_client/app/(dashboard)/orders/page.old.tsx'),
  'orders/page.old.tsx deleted');
assert(!fs.existsSync('/var/www/serpbays/serpbays_client/app/(dashboard)/publisher/my-orders/page.old.tsx'),
  'my-orders/page.old.tsx deleted');
assert(!fs.existsSync('/var/www/serpbays/serpbays_client/app/(dashboard)/publisher/available-orders/page.old.tsx'),
  'available-orders/page.old.tsx deleted');

out('\n=== 10F: Panel20 invalidation tuning ===');
// All 4 hooks now debounce
for (const [name, code] of [
  ['transactions', P_TX],
  ['orders', P_ORD],
  ['withdrawals', P_WIT],
  ['dashboard', P_DASH],
]) {
  assert(/setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]{0,200}invalidateQueries/.test(code) ||
         /pending = setTimeout/.test(code),
    `${name} hook debounces invalidations`);
}
// Dashboard polling removed
assert(!/refetchInterval:\s*\d+\s*\*\s*60\s*\*\s*1000/.test(P_DASH),
  'dashboard refetchInterval removed (WS is primary, refetchOnWindowFocus is backstop)');
// users/[id] handler debounced
assert(/walletPending\s*=\s*null|setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,200}refetchUserScopedData/.test(P_USER),
  'users/[id] handler debounces per-user refetches');
// AddTransactionModal invalidation narrowed
assert(!/queryClient\.invalidateQueries\(\{\s*queryKey:\s*queryKeys\.users\.lists\(\)/.test(P_MODAL),
  'AddTransactionModal no longer invalidates users.lists (covered by WS path)');
assert(!/queryClient\.invalidateQueries\(\{\s*queryKey:\s*queryKeys\.dashboard\.all/.test(P_MODAL),
  'AddTransactionModal no longer invalidates dashboard.all (covered by WS path)');
// ReactQueryDevtools gated
assert(/process\.env\.NODE_ENV\s*!==\s*['"]production['"][\s\S]{0,100}ReactQueryDevtools/.test(P_PROV),
  'ReactQueryDevtools gated on NODE_ENV !== production');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
