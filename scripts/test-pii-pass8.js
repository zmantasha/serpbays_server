#!/usr/bin/env node
/**
 * Regression test — PII pass 8 (per-user daily marketplace browse quota).
 *
 * Closes the bulk-extraction gap that pass-7 (rate limits + pageSize caps)
 * alone couldn't: a determined scraper that respects rate limits can
 * still pull the entire catalog over time. This quota bounds the TOTAL
 * unique marketplace listings any one user can see in 24h.
 *
 * Static checks: the quota module exists, the find() handler wires it
 * into the response-wrapper closure, bypass conditions are correct.
 * Functional checks: instantiate the quota helper and verify it filters
 * correctly across calls.
 *
 * Run: cd serpbays_server && node scripts/test-pii-pass8.js
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');

const fs = require('fs');
let pass = 0, fail = 0;
const out = (...a) => process.stderr.write(a.join(' ') + '\n');
const assert = (cond, label) => {
  if (cond) { pass++; out('  PASS', label); }
  else      { fail++; out('  FAIL', label); }
};
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const QUOTA = read('src/utils/marketplace-quota.js');
const CTRL  = read('src/api/marketplace/controllers/marketplace.js');

out('\n=== A. Quota module exists + correct shape ===');

assert(fs.existsSync('src/utils/marketplace-quota.js'),
  'src/utils/marketplace-quota.js exists');
assert(/module\.exports\s*=\s*\{[\s\S]{0,800}checkAndFilter\b/.test(QUOTA),
  'exports checkAndFilter');
assert(/module\.exports\s*=\s*\{[\s\S]{0,800}getCap\b/.test(QUOTA),
  'exports getCap');
assert(/MARKETPLACE_DAILY_BROWSE_CAP/.test(QUOTA),
  'reads MARKETPLACE_DAILY_BROWSE_CAP env var');
assert(/process\.env\.MARKETPLACE_DAILY_BROWSE_CAP/.test(QUOTA),
  'default cap path reads process.env');
assert(/global\.strapi\?\.io_redis\?\.pubClient/.test(QUOTA),
  'uses the shared Redis client (global.strapi.io_redis.pubClient)');
assert(/scard|sismember|sadd/i.test(QUOTA),
  'uses Redis SET operations (SCARD/SISMEMBER/SADD)');
assert(/inMemoryQuota|fallback/i.test(QUOTA),
  'falls back to in-memory if Redis is unavailable');

out('\n=== B. find() wires the quota into withGateMeta ===');

assert(/require\(['"][\.\/]+utils\/marketplace-quota['"]\)/.test(CTRL),
  'controller requires marketplace-quota');
assert(/marketplaceQuota\.checkAndFilter/.test(CTRL),
  'find() calls quota.checkAndFilter');
assert(/atDailyBrowseCap|dailyBrowseUsed|dailyBrowseCap/.test(CTRL),
  'response meta exposes quota state (used / cap / atQuota)');

// B4: withGateMeta is now async + every return uses await
{
  const findFn = CTRL.match(/async find\(ctx\)[\s\S]*?(?=\n  async [a-zA-Z]+\(ctx\)|\n\}\)\);)/m);
  const body = findFn ? findFn[0] : '';
  const syncReturns = (body.match(/return withGateMeta\(/g) || []).length;
  const asyncReturns = (body.match(/return await withGateMeta\(/g) || []).length;
  assert(syncReturns === 0, 'no sync `return withGateMeta(...)` left (count: ' + syncReturns + ')');
  assert(asyncReturns >= 3, 'every withGateMeta return is awaited (count: ' + asyncReturns + ')');
}

out('\n=== C. Bypass conditions are correct ===');

// C1. Admins bypass
assert(/isAdminUser/.test(CTRL),
  'find() computes isAdminUser flag');
assert(/role\.type[\s\S]{0,80}admin|super_admin/.test(CTRL),
  'admin detection checks role.type for admin / super_admin');

// C2. Publishers viewing own listings bypass
assert(/quotaApplies[\s\S]{0,100}!isPublisherUser/.test(CTRL),
  'quotaApplies excludes publisher users');
assert(/quotaApplies[\s\S]{0,100}!isAdminUser/.test(CTRL),
  'quotaApplies excludes admin users');

out('\n=== D. Functional check — the quota module actually works ===');

(async () => {
  // Re-require fresh; isolate from other tests
  delete require.cache[require.resolve('/var/www/serpbays/serpbays_server/src/utils/marketplace-quota')];
  process.env.MARKETPLACE_DAILY_BROWSE_CAP = '5';
  const q = require('/var/www/serpbays/serpbays_server/src/utils/marketplace-quota');

  assert(q.getCap() === 5, 'getCap reads env override');

  // First call — 3 IDs under cap=5 → all allowed
  const userId = 9999_0001;
  let r = await q.checkAndFilter(userId, [101, 102, 103]);
  assert(r.allowed.length === 3 && r.total === 3 && r.atQuota === false,
    'call 1: 3 new IDs under cap=5 → all allowed, total=3, atQuota=false');

  // Second call — 4,5 fit; 6 overflows (new + over cap → dropped)
  r = await q.checkAndFilter(userId, [104, 105, 106]);
  assert(r.allowed.length === 2 && r.total === 5 && r.atQuota === true,
    'call 2: 2 fit, 1 over cap → atQuota=true, ID 106 dropped');
  assert(r.allowed.includes(104) && r.allowed.includes(105) && !r.allowed.includes(106),
    'call 2: correct IDs dropped (104,105 in; 106 out)');

  // Third call — re-view 101 (already seen → allowed) + new 999 (over cap → dropped)
  r = await q.checkAndFilter(userId, [101, 999]);
  assert(r.allowed.length === 1 && r.allowed[0] === 101 && r.atQuota === true,
    'call 3: re-view allowed (101 in), new ID dropped (999 out)');

  // Different user — fresh quota
  const userId2 = 9999_0002;
  r = await q.checkAndFilter(userId2, [200, 201]);
  assert(r.allowed.length === 2 && r.total === 2 && r.atQuota === false,
    'call 4: different user has fresh quota');

  // Empty input
  r = await q.checkAndFilter(userId, []);
  assert(r.allowed.length === 0,
    'empty input → empty allowed');

  // Invalid userId
  r = await q.checkAndFilter(null, [1, 2]);
  assert(r.allowed.length === 2,
    'null userId → pass-through (no quota for anonymous)');

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
