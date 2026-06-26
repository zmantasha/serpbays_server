#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 12: secrets + secret-leaks.
 *
 * Findings closed (workflow IDs in parens):
 *   - CATASTROPHIC (mw-find-jwt-secret-default / devops2-jwt-secret-fallback):
 *     config/plugins.js had jwtSecret: env('JWT_SECRET', 'your-secret-key-here').
 *     If JWT_SECRET was unset in any production environment, Strapi
 *     would silently sign every user's JWT with the literal string
 *     'your-secret-key-here' — and anyone reading the public repo would
 *     know the signing key, enabling forging of arbitrary user JWTs.
 *     Fix: requireSecret(env, 'JWT_SECRET') — fails loudly at boot if
 *     the secret is missing or shorter than 16 chars.
 *
 *   - HIGH (log-find-phonepe-saltkey): src/api/transaction/services/phonepe.js
 *     had `console.log(this.saltKey)` and `console.log(this.merchantId)` at
 *     the top of createTransaction(). Salt key is the HMAC signing secret
 *     used by both generateSignature() AND verifySignature() — anyone with
 *     log access could compute valid PhonePe webhook callbacks to credit
 *     arbitrary wallets. Removed.
 *
 *   - MEDIUM (log-find-phonepe-full-request): the same handler dumped
 *     the full paymentRequest object (`console.log("payment", paymentRequest)`),
 *     the generated signature, and the full axios response (which can
 *     include request headers + auth tokens). Removed.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass12.js
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

const PLUGINS = read('config/plugins.js');
const PHONE   = read('src/api/transaction/services/phonepe.js');

out('\n=== 1) JWT_SECRET fallback removed; fail-loud guard added ===');
assert(!/env\(['"]JWT_SECRET['"],\s*['"]your-secret-key-here['"]\)/.test(PLUGINS),
  "no remaining env('JWT_SECRET', 'your-secret-key-here') fallback");
assert(/function\s+requireSecret\s*\(/.test(PLUGINS),
  'requireSecret() helper defined');
assert(/jwtSecret:\s*requireSecret\(\s*env\s*,\s*['"]JWT_SECRET['"]\s*\)/.test(PLUGINS),
  'jwtSecret loaded via requireSecret (fails at boot if missing)');
assert(/length\s*<\s*16/.test(PLUGINS),
  'minimum length check (rejects pathologically-short secrets)');
// Verify the helper actually throws, not just warns.
assert(/throw\s+new\s+Error\(/.test(PLUGINS),
  'requireSecret throws on missing/weak secret (no silent fallback)');

out('\n=== 2) phonepe.js — saltKey + signature + full-payload logs removed ===');
// Comment-strip first so explanatory text doesn't false-positive.
const phoneCode = PHONE.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/console\.log\(this\.saltKey\)/.test(phoneCode),
  'console.log(this.saltKey) removed (the CRITICAL signing-key leak)');
assert(!/console\.log\(this\.merchantId\)/.test(phoneCode),
  'console.log(this.merchantId) standalone debug log removed');
assert(!/console\.log\("payment",\s*paymentRequest\)/.test(phoneCode),
  'full paymentRequest object log removed');
assert(!/console\.log\("signature",\s*signature\)/.test(phoneCode),
  'signature log removed');
assert(!/console\.log\("response",\s*response\)/.test(phoneCode),
  'full axios response log removed (had request headers + auth tokens)');

out('\n=== 3) phonepe.js — initialization log keeps only Set/Missing indicator ===');
// The constructor log at L24 is correct: it logs "Set" or "Missing", not
// the salt key itself. Preserve that.
assert(/console\.log\(`\[PHONEPE\] Salt Key:\s*\$\{this\.saltKey\s*\?\s*'Set'\s*:\s*'Missing'\}`\)/.test(PHONE),
  'constructor logs Salt Key as Set/Missing boolean (not the actual key)');

out('\n=== 4) phonepe.js — credential check still throws on misconfig ===');
// The credential check moved before the try block in my edit attempt.
// Whether it's before or inside try, the behaviour is the same (throws).
assert(/if\s*\(\s*!this\.merchantId\s*\|\|\s*!this\.saltKey\s*\)[\s\S]{0,200}throw\s+new\s+Error\(\s*'PhonePe credentials not configured'/.test(PHONE),
  'createTransaction throws when credentials missing');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
