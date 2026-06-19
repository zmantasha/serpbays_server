#!/usr/bin/env node
/**
 * Regression test for audit C4 — `POST /api/transactions/manual-update-razorpay`
 * admin-only gating.
 *
 * Pre-fix exploit: route config was `auth: { strategies: ['jwt'] }`, which in
 * Strapi 5 is a JWT-presence check WITHOUT scope/role enforcement. Any
 * authenticated user could POST `{order_id:'<their pending razorpay order>',
 * status:'success'}` and the handler would flip their pending tx to success
 * and credit the linked wallet — money for nothing.
 *
 * Post-fix: route uses `auth: false` + `policies: ['global::is-admin']` +
 * `middlewares: ['global::admin-jwt-auth']`, identical to the sibling
 * `cleanup-pending-razorpay` route. The admin-jwt-auth middleware validates
 * a real admin-panel JWT (different secret from user JWT); is-admin policy
 * confirms admin role membership.
 *
 * This test is a STATIC grep — no Strapi load.
 *
 * Run: cd serpbays_server && node scripts/test-manual-update-razorpay-admin-gated.js
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

const ROUTES = 'src/api/transaction/routes/transaction.js';
const routes = read(ROUTES);

out('\n=== 1) Route file is intact + still defines the manual-update-razorpay path ===');
assert(routes.length > 0, `${ROUTES} exists`);
assert(
  /['"]\/api\/transactions\/manual-update-razorpay['"]/.test(routes),
  'manual-update-razorpay path still defined (we are gating, not deleting)'
);
assert(
  /handler\s*:\s*['"]razorpay-webhook\.manualUpdate['"]/.test(routes),
  'razorpay-webhook.manualUpdate handler binding still present'
);

out('\n=== 2) The route block contains the admin-gate trio ===');
// Slice the file from the manual-update-razorpay path to the next closing }
const start = routes.indexOf("'/api/transactions/manual-update-razorpay'");
assert(start >= 0, 'found anchor for manual-update-razorpay route');
// Search forward up to next 200 chars (enough to capture the config block).
const block = routes.slice(start, start + 600);
assert(
  /auth\s*:\s*false/.test(block),
  'auth: false (admin-jwt-auth middleware will set ctx.state.auth)'
);
assert(
  /policies\s*:\s*\[\s*['"]global::is-admin['"]/.test(block),
  "policies includes 'global::is-admin'"
);
assert(
  /middlewares\s*:\s*\[\s*['"]global::admin-jwt-auth['"]/.test(block),
  "middlewares includes 'global::admin-jwt-auth'"
);

out('\n=== 3) The vulnerable JWT-only config is NOT present on this route ===');
// The vulnerable pattern was: auth: { strategies: ['jwt'] } with NO scope.
// Forbid that exact shape in the route block.
assert(
  !/auth\s*:\s*\{\s*strategies\s*:\s*\[\s*['"]jwt['"]\s*\]\s*\}/.test(block),
  'no auth.strategies-only config (the pre-fix vulnerable shape)'
);

out('\n=== 4) Required policy + middleware files exist ===');
assert(
  fs.existsSync('src/policies/is-admin.js'),
  'global::is-admin policy file exists'
);
assert(
  fs.existsSync('src/middlewares/admin-jwt-auth.js'),
  'global::admin-jwt-auth middleware file exists'
);

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
