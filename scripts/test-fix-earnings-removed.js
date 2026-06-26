#!/usr/bin/env node
/**
 * Regression test for audit C5 — `POST /api/wallet/fix-earnings` removed.
 *
 * Pre-fix: `src/api/user-wallet/routes/user-wallet.js:158-166` defined the
 * route with `auth: {}` (any authenticated user). The handler at
 * `src/api/user-wallet/controllers/user-wallet.js:726-831` looped over ALL
 * approved/completed orders system-wide and credited
 * `order.totalAmount` to the publisher wallet. The existing-transaction
 * branch (l.763-780) double-credited on every call. Authenticated DB grant
 * (up_permissions perm_id 1826 → role 1) made it exploitable by any user.
 *
 * This test is a STATIC grep — no network, no Strapi load. It asserts:
 *   1. The route file does NOT define POST /api/wallet/fix-earnings.
 *   2. The route file does NOT reference the handler symbol.
 *   3. The controller file does NOT define `fixCompletedOrderEarnings`.
 *   4. The kill-migration exists and targets the action string.
 *
 * Run: cd serpbays_server && node scripts/test-fix-earnings-removed.js
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

const routeFile      = 'src/api/user-wallet/routes/user-wallet.js';
const controllerFile = 'src/api/user-wallet/controllers/user-wallet.js';
const migrationFile  = 'database/migrations/2026.06.17T00.00.00.security-remove-fix-earnings-route.js';

out('\n=== 1) Route file no longer defines POST /api/wallet/fix-earnings ===');
const route = read(routeFile);
assert(route.length > 0, `${routeFile} exists`);
assert(!/['"]\/api\/wallet\/fix-earnings['"]/.test(route), 'no fix-earnings path literal');
// We allow the forensic comment that names the removed symbol; we forbid
// the `handler: '…fixCompletedOrderEarnings'` binding string Strapi would
// use to route requests.
assert(
  !/handler\s*:\s*['"][^'"]*fixCompletedOrderEarnings['"]/.test(route),
  'no handler-binding string for fixCompletedOrderEarnings'
);

out('\n=== 2) Controller no longer defines fixCompletedOrderEarnings ===');
const ctrl = read(controllerFile);
assert(ctrl.length > 0, `${controllerFile} exists`);
// We allow the comment block to mention the removed symbol. We forbid the
// method definition itself: `async fixCompletedOrderEarnings(`.
assert(
  !/async\s+fixCompletedOrderEarnings\s*\(/.test(ctrl),
  'no async fixCompletedOrderEarnings(...) method body'
);

out('\n=== 3) Kill-migration exists and targets the action string ===');
const mig = read(migrationFile);
assert(mig.length > 0, `${migrationFile} exists`);
assert(
  /api::user-wallet\.user-wallet\.fixCompletedOrderEarnings/.test(mig),
  'migration references the action string'
);
assert(/up_permissions/.test(mig), 'migration touches up_permissions');
assert(/up_permissions_role_lnk/.test(mig), 'migration touches up_permissions_role_lnk');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
