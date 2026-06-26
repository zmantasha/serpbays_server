#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 11: payment-gateways + exit-intent-lead.
 *
 * Findings closed:
 *   - HIGH: exit-intent-lead.create was the default Strapi core handler.
 *     Public role had the create grant (intentional for the marketing-
 *     site popup). The default controller accepts EVERY column in `data`,
 *     so an anonymous caller could mass-assign `status` ('qualified' /
 *     'won'), `internalNotes` (admin-visible field; potential XSS),
 *     `clerkUserId` / `userName` / `userEmail` (schema labels these as
 *     "server-detected, not client-trusted"). Now explicit field
 *     allow-list; identity fields populated from ctx.state.user only.
 *   - HIGH: payment-gateways PUT /settings used `auth.scope: ['admin']` —
 *     scope matches permission action names not role types, so the route
 *     was inaccessible to everyone including super_admin (same broken-
 *     scope bug as bank-transfer-request in Pass 7). Replaced with
 *     `policies: ['global::is-admin']`.
 *   - MEDIUM (cost / DoS): payment-gateways.calculateFees (PUBLIC, no
 *     auth) accepted unbounded `amount` and unrecognised `paymentMethod`.
 *     Each Razorpay/PhonePe call triggers an outbound exchange-rate API
 *     hit. Flooding with junk would burn through outbound quotas. Now
 *     bounds amount ≤ $1M, validates paymentMethod against an enum,
 *     length-caps the input.
 *   - LOW: payment-gateways.updateSettings was a stub that console.log'd
 *     the body and returned `Settings updated` regardless of any
 *     persistence. Misleading for any admin UI built against it. Now
 *     returns HTTP 501 Not Implemented + warn log so callers surface.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass11.js
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

const EIL_CTRL  = read('src/api/exit-intent-lead/controllers/exit-intent-lead.js');
const PG_CTRL   = read('src/api/payment-gateways/controllers/payment-gateways.js');
const PG_ROUTES = read('src/api/payment-gateways/routes/payment-gateways.js');

out('\n=== 1) exit-intent-lead.create — explicit allow-list override ===');
assert(/async\s+create\s*\(\s*ctx\s*\)/.test(EIL_CTRL),
  'create() overridden (default core handler no longer used)');
// Server-detected identity fields are populated from ctx.state.user — not from body
assert(/sessionUser\s*=\s*ctx\.state\?\.user/.test(EIL_CTRL),
  'identity fields come from ctx.state.user');
// Admin-only fields are NEVER assigned in the payload
const eilCtrlCode = EIL_CTRL.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/payload\.status\s*=/.test(eilCtrlCode),
  'status NEVER assigned from request body (no mass-assignment)');
assert(!/payload\.internalNotes\s*=/.test(eilCtrlCode),
  'internalNotes NEVER assigned from request body');
// Role enum validated
assert(/VALID_ROLES\s*=\s*\['buyer',\s*'seller'\]/.test(EIL_CTRL),
  'VALID_ROLES enum check');
// Allowed-fields list shape (clipStr-driven)
assert(/clipStr\s*\(\s*body\[f\]\s*,\s*LIMITS\[f\]\s*\)/.test(EIL_CTRL),
  'optional fields go through clipStr() length cap');
// LIMITS table present
assert(/\bemail:\s*254\b/.test(EIL_CTRL) && /\bname:\s*200\b/.test(EIL_CTRL),
  'LIMITS table caps email (254) + name (200) lengths');
// Response shape narrowed (no full entity leak)
assert(/data:\s*\{\s*id:\s*entity\.id,\s*role:\s*entity\.role\s*\}/.test(EIL_CTRL),
  'response is { id, role } only (no internal field leak)');

out('\n=== 2) payment-gateways route — broken admin scope replaced ===');
// Strip comments
const pgRoutesCode = PG_ROUTES.split('\n').map(l => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')).join('\n');
assert(!/scope:\s*\['admin'\]/.test(pgRoutesCode),
  "no remaining auth.scope: ['admin'] in code (was matched against permission actions)");
assert(/policies:\s*\['global::is-admin'\]/.test(pgRoutesCode),
  'admin gate now uses global::is-admin policy');

out('\n=== 3) calculateFees — input bounds + method enum ===');
const cfStart = PG_CTRL.indexOf('async calculateFees(ctx)');
const cfEnd   = PG_CTRL.indexOf('async updateSettings(ctx)');
const cf      = cfStart > 0 && cfEnd > cfStart ? PG_CTRL.slice(cfStart, cfEnd) : '';
assert(cf.length > 0, 'calculateFees body sliced');
assert(/VALID_METHODS\s*=\s*new\s+Set\(\[\s*'stripe',\s*'paypal',\s*'razorpay',\s*'phonepe',\s*'bank_transfer'\s*\]\)/.test(cf),
  'paymentMethod validated against enum');
assert(/parsedAmount\s*>\s*1_?000_?000/.test(cf),
  'amount capped at $1M');
assert(/Number\.isFinite\s*\(\s*parsedAmount\s*\)/.test(cf),
  'amount validated as finite number');
assert(/paymentMethod\.length\s*>\s*32/.test(cf),
  'paymentMethod length-capped (rejects pathological inputs)');

out('\n=== 4) updateSettings — stub returns 501 ===');
const usStart = PG_CTRL.indexOf('async updateSettings(ctx)');
const us      = usStart > 0 ? PG_CTRL.slice(usStart) : '';
assert(/ctx\.status\s*=\s*501/.test(us),
  'updateSettings returns HTTP 501 Not Implemented');
assert(/strapi\.log\??\.warn/.test(us),
  'updateSettings warns server-side on every call');
// Pre-fix stub no longer present
assert(!/console\.log\(`\[PAYMENT GATEWAYS\] Updating settings for/.test(us),
  'stub success-log gone');
// Strip comments so the explanatory text mentioning the prior message
// doesn't false-positive.
const usCode = us.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/ctx\.send\(\s*\{[\s\S]{0,200}Settings updated for/.test(usCode),
  'misleading ctx.send success-message removed as code');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
