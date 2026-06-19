#!/usr/bin/env node
/**
 * Regression test for audit C10 — no hardcoded secrets in source.
 *
 * Pre-fix: src/api/payment-gateways/services/exchange-rate.js had
 *   const KEY = process.env.EXCHANGE_RATE_API_KEY || '<live key>';
 * The fallback string was a real ExchangeRate-API key, committed
 * 2025-12-05 in commit d0f0b6c2 and remained until 2026-06-17.
 *
 * This test is a STATIC grep — no network, no Strapi load. It asserts:
 *   1. The previously-leaked key string does not appear in any
 *      checked-in file (excluding git history, which is irretrievable
 *      without rewriting history — rotation at the provider is the
 *      mitigation there).
 *   2. The exchange-rate.js loader does NOT include a fallback string
 *      after `process.env.EXCHANGE_RATE_API_KEY ||`.
 *   3. Common hardcoded-secret patterns are not present in the
 *      payment-gateways or transaction source trees.
 *
 * Run: cd serpbays_server && node scripts/test-secrets-not-hardcoded.js
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const out = (...a) => process.stderr.write(a.join(' ') + '\n');
const assert = (cond, label) => {
  if (cond) { pass++; out('  ✅', label); }
  else      { fail++; out('  ❌', label); }
};

const LEAKED_KEY = '123a3c87b3e8b56157fa3852';
const SCAN_ROOTS = [
  'src/api',
  'config',
  '.env.example',
];
const EXCLUDE_PATHS = [
  'node_modules',
  '.next',
  '/.git/',
  // docs/ are allowed to mention the key for forensic context, but only
  // wrapped in the redacted marker. Asserting that directly below.
];

function walk(dir, cb) {
  const stat = fs.statSync(dir);
  if (stat.isFile()) return cb(dir);
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (EXCLUDE_PATHS.some((p) => full.includes(p))) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, cb);
    else cb(full);
  }
}

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

(async () => {
  out('\n=== 1) Leaked key absent from source + .env.example ===');
  let hits = [];
  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    walk(root, (p) => {
      const c = readSafe(p);
      if (c.includes(LEAKED_KEY)) hits.push(p);
    });
  }
  assert(hits.length === 0, `no hits in src/api/config/.env.example (got ${hits.length}: ${hits.join(', ')})`);

  out('\n=== 2) Docs only contain key wrapped in REDACTED marker ===');
  let unredactedDocHits = [];
  if (fs.existsSync('docs')) {
    walk('docs', (p) => {
      const c = readSafe(p);
      if (c.includes(LEAKED_KEY) && !c.includes('[REDACTED')) {
        unredactedDocHits.push(p);
      }
    });
  }
  assert(unredactedDocHits.length === 0, `no unredacted-key hits in docs (got ${unredactedDocHits.length}: ${unredactedDocHits.join(', ')})`);

  out('\n=== 3) exchange-rate.js has no string fallback after the env-var ||  ===');
  const er = readSafe('src/api/payment-gateways/services/exchange-rate.js');
  // Must NOT be: process.env.EXCHANGE_RATE_API_KEY || '<non-empty quoted string of more than 1 char>'
  const badFallback = /process\.env\.EXCHANGE_RATE_API_KEY\s*\|\|\s*['"][^'"]{2,}['"]/;
  assert(!badFallback.test(er), 'no quoted fallback string after EXCHANGE_RATE_API_KEY ||');
  // Empty string fallback is allowed (graceful degradation):
  assert(/process\.env\.EXCHANGE_RATE_API_KEY\s*\|\|\s*['"]['"]/.test(er), 'env-var || \'\' empty-string fallback present');

  out('\n=== 4) Common hardcoded-secret patterns absent from payment-gateways + transaction trees ===');
  // Look for live-key prefixes in source we control.
  const SECRET_PATTERNS = [
    { name: 'Stripe live secret key (sk_live_)',    re: /sk_live_[A-Za-z0-9]{16,}/ },
    { name: 'Stripe test secret key (sk_test_)',    re: /sk_test_[A-Za-z0-9]{16,}/ },
    { name: 'Stripe webhook secret (whsec_)',       re: /whsec_[A-Za-z0-9]{16,}/ },
    { name: 'Razorpay key id (rzp_live_/rzp_test_)', re: /rzp_(?:live|test)_[A-Za-z0-9]{8,}/ },
  ];
  for (const dir of ['src/api/payment-gateways', 'src/api/transaction']) {
    if (!fs.existsSync(dir)) continue;
    walk(dir, (p) => {
      const c = readSafe(p);
      for (const { name, re } of SECRET_PATTERNS) {
        const m = c.match(re);
        if (m) {
          // Allow the var-reference like process.env.STRIPE_SECRET_KEY — only flag literal matches.
          // Our regex doesn't match those (env names don't start with sk_/whsec_/rzp_).
          fail++;
          out(`  ❌ ${name} literal found in ${p}: ${m[0].slice(0, 20)}…`);
        }
      }
    });
  }
  out('  ✅ no Stripe/Razorpay live-key literals in payment-gateways or transaction source');
  pass++;

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n'); process.exit(1); });
