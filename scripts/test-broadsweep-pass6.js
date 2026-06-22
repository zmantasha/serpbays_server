#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 6: invoice + auth audit.
 *
 * Closes:
 *   - HIGH: dead `custom-register` controller + route (mass-assignment on
 *     Advertiser / Publisher role flags; no rate limiting; duplicate
 *     /auth/register path conflict with clerk.js). Deleted entirely.
 *     Clerk is the sole register/sync path (memory: "Clerk owns ALL auth").
 *   - MEDIUM: invoice.download returned 403 on cross-tenant (enumeration
 *     vector via sequential invoice ids). Now 404 + integer id validation.
 *     `populate: ['user']` returned full up_users row; narrowed to {id}.
 *   - MEDIUM: email-confirmation.sendVerificationEmail leaked account
 *     existence — distinct error responses for "not found" vs "already
 *     confirmed" vs "sent". Attacker could probe registration state by
 *     email. Now always returns {ok:true} regardless of input.
 *   - MEDIUM: email-confirmation.sendVerificationEmail had no resend
 *     cooldown — email-bomb attack. Now enforces 60s cooldown between
 *     resends via confirmationTokenCreatedAt.
 *   - LOW: email-confirmation handlers echoed error.message in responses;
 *     Strapi-internal errors leaked. Server-side log only now.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass6.js
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
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const INV = read('src/api/invoice/controllers/invoice.js');
const EMC = read('src/api/auth/controllers/email-confirmation.js');

out('\n=== 1) custom-register: route + controller files removed ===');
assert(!exists('src/api/auth/routes/custom-register.js'),
  'src/api/auth/routes/custom-register.js deleted');
assert(!exists('src/api/auth/controllers/custom-register.js'),
  'src/api/auth/controllers/custom-register.js deleted');
// No surviving references inside src/ (excluding node_modules + backups)
let refCount = 0;
function walkSrc(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkSrc(p);
    else if (/\.(js|ts|json)$/.test(entry.name)) {
      const content = read(p);
      if (content.includes('custom-register')) refCount += 1;
    }
  }
}
walkSrc('src');
assert(refCount === 0, `no custom-register references inside src/ (found ${refCount})`);

out('\n=== 2) invoice.download — id validation + populate narrowed + 404 on cross-tenant ===');
const dStart = INV.indexOf('async download(ctx)');
const dEnd   = INV.length;
const dBody  = dStart > 0 ? INV.slice(dStart, dEnd) : '';
assert(dBody.length > 0, 'download body sliced');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(dBody),
  'download validates id as positive integer');
assert(/populate:\s*\{\s*user:\s*\{\s*fields:\s*\['id'\]\s*\}\s*\}/.test(dBody),
  'download populates user with {id} only (no up_users PII leak)');
assert(/if\s*\(\s*!invoice\s*\|\|\s*invoice\.user\?\.id\s*!==\s*userId\s*\)[\s\S]{0,200}ctx\.notFound/.test(dBody),
  'download returns 404 (not 403) on missing OR cross-tenant');
assert(!/ctx\.forbidden\(/.test(dBody),
  'download never returns 403 (enumeration defense)');

out('\n=== 3) email-confirmation.emailConfirmation — no error.message echo ===');
const emcStart = EMC.indexOf('async emailConfirmation(ctx)');
const emcEnd   = EMC.indexOf('async sendVerificationEmail(ctx)');
const emcBody  = emcStart > 0 && emcEnd > emcStart ? EMC.slice(emcStart, emcEnd) : '';
assert(emcBody.length > 0, 'emailConfirmation body sliced');
assert(!/details:\s*error\.message/.test(emcBody),
  'emailConfirmation no longer echoes details: error.message');

out('\n=== 4) email-confirmation.sendVerificationEmail — enumeration defense ===');
const svStart = EMC.indexOf('async sendVerificationEmail(ctx)');
const svEnd   = EMC.length;
const svBody  = svStart > 0 ? EMC.slice(svStart, svEnd) : '';
assert(svBody.length > 0, 'sendVerificationEmail body sliced');
// Pre-fix returned distinct error responses; now always {ok:true} on the
// success / unknown-account / already-confirmed / cooldown paths.
const okTrueReturns = (svBody.match(/ctx\.send\(\s*\{\s*ok:\s*true\s*\}\s*\)/g) || []).length;
assert(okTrueReturns >= 4,
  `sendVerificationEmail returns {ok:true} on every non-rate-limited path (found ${okTrueReturns})`);
assert(!/User not found/.test(svBody),
  'no "User not found" leakage');
assert(!/Email already verified/.test(svBody),
  'no "Email already verified" leakage');
assert(!/error:\s*'user_not_found'/.test(svBody),
  'no user_not_found error code in response');
assert(!/error:\s*'already_confirmed'/.test(svBody),
  'no already_confirmed error code in response');

out('\n=== 5) sendVerificationEmail — resend cooldown enforced ===');
assert(/RESEND_COOLDOWN_MS\s*=\s*60_?000/.test(svBody),
  'RESEND_COOLDOWN_MS = 60s defined');
assert(/confirmationTokenCreatedAt[\s\S]{0,80}age\s*<\s*RESEND_COOLDOWN_MS/.test(svBody),
  'cooldown check against confirmationTokenCreatedAt');

out('\n=== 6) sendVerificationEmail — error path does not echo error.message ===');
assert(!/details:\s*error\.message/.test(svBody),
  'sendVerificationEmail no longer echoes details: error.message');
assert(!/error:\s*'send_failed'/.test(svBody),
  'no send_failed error code in response');

out('\n=== 7) sendVerificationEmail — input validation gates ===');
assert(/typeof\s+email\s*!==\s*'string'\s*\|\|\s*!email\.includes\('@'\)/.test(svBody),
  'rejects non-string / missing-@ inputs with the same generic {ok:true}');
assert(/email\.toLowerCase\(\)\.trim\(\)/.test(svBody),
  'normalizes email before lookup');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
