#!/usr/bin/env node
/**
 * Regression test — PII pass 10 (composite security audit).
 *
 * Locks in protections for six audit findings:
 *
 *   A. (HIGH)   gscRefreshToken / gsc_refresh_token never returned by an API
 *   B. (HIGH)   /api/wallet/redeem-promo is rate-limited (per user + per IP +
 *               cooldown after N failures)
 *   C. (HIGH)   POST /withdrawal-requests ownership + balance + OTP gates
 *   D. (MEDIUM) Marketplace bulk-scrape defenses (pageSize/page/daily-quota)
 *   E. (MEDIUM) Order accept/complete enforce party-ownership
 *   F. (MEDIUM) /api/global-config public allow-list (no autoApproveDays /
 *               autoReleaseDays / paymentGateways.enabled leak)
 *
 * Static-grep only — runs offline against the source tree.
 * Run: cd serpbays_server && node scripts/test-pii-pass10.js
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

const PUB_WEBSITE_SCHEMA = read('src/api/publisher-website/content-types/publisher-website/schema.json');
const MARKETPLACE_CTRL   = read('src/api/marketplace/controllers/marketplace.js');
const WALLET_CTRL        = read('src/api/user-wallet/controllers/user-wallet.js');
const LIMITER            = read('src/utils/promo-redeem-limiter.js');
const QUOTA              = read('src/utils/marketplace-quota.js');
const WITHDRAW_CTRL      = read('src/api/withdrawal-request/controllers/withdrawal-request.js');
const ORDER_CTRL         = read('src/api/order/controllers/order.js');
const ORDER_SVC          = read('src/api/order/services/order.js');
const GCFG_CTRL          = read('src/api/global-config/controllers/global-config.js');

out('\n=== A. gscRefreshToken never returned by API ===');

// Schema-level: private + listed in privateAttributes (Strapi auto-strips).
{
  const schema = (() => { try { return JSON.parse(PUB_WEBSITE_SCHEMA); } catch { return {}; } })();
  const tokenAttr = schema?.attributes?.gscRefreshToken;
  assert(!!tokenAttr,                          'publisher-website schema declares gscRefreshToken');
  assert(tokenAttr && tokenAttr.private === true,
    'gscRefreshToken is marked `private: true` (Strapi sanitizer auto-strips)');
  const privAttrs = schema?.options?.privateAttributes || [];
  assert(Array.isArray(privAttrs) && privAttrs.includes('gscRefreshToken'),
    'gscRefreshToken is listed in schema.options.privateAttributes');
}

// Marketplace controller's NEVER_EXPOSE list includes the denormalized
// gsc_refresh_token column (in case it ever lands on a marketplace row).
assert(/MARKETPLACE_NEVER_EXPOSE\s*=\s*\[[^\]]*['"]gsc_refresh_token['"]/.test(MARKETPLACE_CTRL),
  'marketplace NEVER_EXPOSE list includes gsc_refresh_token');

out('\n=== B. Promo-redeem brute-force throttling ===');

// Limiter module exists with the expected shape.
assert(LIMITER.length > 0, 'promo-redeem-limiter module exists');
assert(/module\.exports\s*=\s*\{[\s\S]*?check\b/.test(LIMITER),
  'limiter exports check()');
assert(/module\.exports\s*=\s*\{[\s\S]*?recordFailure\b/.test(LIMITER),
  'limiter exports recordFailure()');
assert(/PROMO_REDEEM_ATTEMPT_LIMIT/.test(LIMITER),
  'limiter reads PROMO_REDEEM_ATTEMPT_LIMIT env var');
assert(/PROMO_REDEEM_FAILURE_LIMIT/.test(LIMITER),
  'limiter reads PROMO_REDEEM_FAILURE_LIMIT env var');
assert(/PROMO_REDEEM_IP_LIMIT/.test(LIMITER),
  'limiter reads PROMO_REDEEM_IP_LIMIT env var');
assert(/PROMO_REDEEM_FAILURE_COOLDOWN_S/.test(LIMITER),
  'limiter reads PROMO_REDEEM_FAILURE_COOLDOWN_S env var');
assert(/global\.strapi\?\.io_redis\?\.pubClient/.test(LIMITER),
  'limiter prefers Redis (with in-memory fallback)');

// redeemPromo handler imports + uses the limiter.
{
  const m = WALLET_CTRL.match(/async redeemPromo\(ctx\)[\s\S]{0,3000}/);
  const body = m ? m[0] : '';
  assert(body.length > 0, 'redeemPromo handler exists');
  assert(/require\(['"][\.\/]+utils\/promo-redeem-limiter['"]\)/.test(body),
    'redeemPromo requires the promo-redeem-limiter module');
  assert(/promoLimiter\.check\(/.test(body),
    'redeemPromo calls limiter.check() before processing');
  assert(/recordFailure/.test(WALLET_CTRL),
    'redeemPromo calls limiter.recordFailure on invalid-code paths');
  assert(/ctx\.throw\(429/.test(body) || /status\s*=\s*429/.test(body),
    'redeemPromo returns HTTP 429 when the limiter blocks');
  assert(/Retry-After/.test(body),
    'redeemPromo sets Retry-After header when the limiter blocks');
}

out('\n=== C. Withdrawal request ownership + balance + OTP ===');

{
  // The create handler is large (~500 lines) — check the WHOLE file body
  // for these markers rather than a windowed slice.
  assert(/async create\(ctx\)/.test(WITHDRAW_CTRL),
    'withdrawal-request create handler exists');
  // Auth gate.
  assert(/ctx\.state\.user/.test(WITHDRAW_CTRL),
    'create requires ctx.state.user');
  // OTP gate.
  assert(/withdrawalOtp/.test(WITHDRAW_CTRL),
    'create requires withdrawalOtp');
  // OTP amount-binding (prevents reusing a small-amount OTP).
  assert(/withdrawalOtpAmount/.test(WITHDRAW_CTRL),
    'create rejects when OTP was issued for a different amount');
  // OTP attempt counter (brute-force protection on OTP).
  assert(/withdrawalOtpAttempts/.test(WITHDRAW_CTRL),
    'create tracks withdrawalOtpAttempts (OTP brute-force protection)');
  // Constant-time comparison.
  assert(/safeCompareOtp/.test(WITHDRAW_CTRL),
    'OTP comparison uses safeCompareOtp (constant-time)');
  // Balance check.
  assert(/mainBalance\s*<\s*totalDeduction|Insufficient withdrawable funds/.test(WITHDRAW_CTRL),
    'create validates available balance before approving');
  // Race-safe wallet-locked re-check inside the DB transaction.
  assert(/lockedMainBalance\s*<\s*totalDeduction|race-checked under wallet lock/i.test(WITHDRAW_CTRL),
    'create re-checks balance under a row-level wallet lock (race-safe)');
  // Ownership: publisher = ctx.state.user.id (NOT body-supplied).
  assert(/publisher:\s*ctx\.state\.user\.id/.test(WITHDRAW_CTRL),
    'create binds publisher to ctx.state.user.id (no IDOR via request body)');
}

out('\n=== D. Marketplace anti-scraping defenses ===');

assert(/MARKETPLACE_MAX_PAGE_SIZE/.test(MARKETPLACE_CTRL),
  'marketplace caps pageSize via MARKETPLACE_MAX_PAGE_SIZE');
assert(/MARKETPLACE_MAX_PAGE\b/.test(MARKETPLACE_CTRL),
  'marketplace caps page number via MARKETPLACE_MAX_PAGE');
assert(QUOTA.length > 0,
  'marketplace-quota module exists (daily unique-listing cap)');
assert(/MARKETPLACE_DAILY_BROWSE_CAP/.test(QUOTA),
  'quota reads MARKETPLACE_DAILY_BROWSE_CAP env var');
assert(/marketplaceQuota\.checkAndFilter/.test(MARKETPLACE_CTRL),
  'marketplace find wires the per-user daily quota');
assert(/stripPrivateFilters/.test(MARKETPLACE_CTRL),
  'marketplace strips caller-supplied filters on private fields');

out('\n=== E. Order accept/complete authorization ===');

// acceptOrder service has explicit isDirectPublisher || isSnapshotPublisher check.
{
  const m = ORDER_SVC.match(/async acceptOrder\(id,\s*user\)[\s\S]{0,4000}/);
  const body = m ? m[0] : '';
  assert(body.length > 0, 'orders service acceptOrder handler exists');
  assert(/isDirectPublisher/.test(body),
    'acceptOrder computes isDirectPublisher flag');
  assert(/isSnapshotPublisher/.test(body),
    'acceptOrder computes isSnapshotPublisher flag (legacy email match)');
  assert(/!isDirectPublisher\s*&&\s*!isSnapshotPublisher/.test(body),
    'acceptOrder throws when caller is neither direct nor snapshot publisher');
}

// completeOrder controller has explicit `if advertiser.id !== user.id` check.
{
  const m = ORDER_CTRL.match(/async completeOrder\(ctx\)[\s\S]{0,4000}/);
  const body = m ? m[0] : '';
  assert(body.length > 0, 'orders controller completeOrder handler exists');
  assert(/order\.advertiser\.id\s*!==\s*user\.id/.test(body),
    'completeOrder rejects when caller is not the advertiser');
  assert(/order\.orderStatus\s*!==\s*['"]delivered['"]/.test(body),
    'completeOrder rejects orders not in `delivered` status');
}

out('\n=== F. Global-config public allow-list ===');

// Controller has a find override (no longer the default).
assert(/async find\(ctx\)/.test(GCFG_CTRL),
  'global-config controller defines async find override');
// PUBLIC_FIELDS + ADMIN_ONLY_FIELDS constants present.
assert(/PUBLIC_FIELDS\s*=\s*\[/.test(GCFG_CTRL),
  'global-config defines PUBLIC_FIELDS allow-list');
assert(/ADMIN_ONLY_FIELDS\s*=\s*\[[^\]]*['"]autoApproveDays['"]/.test(GCFG_CTRL),
  'global-config ADMIN_ONLY_FIELDS includes autoApproveDays');
assert(/ADMIN_ONLY_FIELDS\s*=\s*\[[^\]]*['"]autoReleaseDays['"]/.test(GCFG_CTRL),
  'global-config ADMIN_ONLY_FIELDS includes autoReleaseDays');
// Admin check.
assert(/isAdminUser/.test(GCFG_CTRL),
  'global-config differentiates admin vs non-admin responses');
// Non-admin shaping of paymentGateways drops disabled + description.
assert(/shapePaymentGatewaysPublic/.test(GCFG_CTRL),
  'global-config shapes paymentGateways (drops disabled + internal notes)');
assert(/cfg\.enabled\s*===\s*false/.test(GCFG_CTRL),
  'global-config drops paymentGateways with enabled=false from non-admin response');

out('\n=== G. Functional check — limiter actually blocks after threshold ===');

(async () => {
  delete require.cache[require.resolve('/var/www/serpbays/serpbays_server/src/utils/promo-redeem-limiter')];
  process.env.PROMO_REDEEM_ATTEMPT_LIMIT = '3';
  process.env.PROMO_REDEEM_FAILURE_LIMIT = '2';
  process.env.PROMO_REDEEM_FAILURE_COOLDOWN_S = '60';
  const limiter = require('/var/www/serpbays/serpbays_server/src/utils/promo-redeem-limiter');

  // Fresh user — first 3 attempts allowed.
  const uid = 9999_0010;
  const ip = '203.0.113.7';
  let r;
  r = await limiter.check(uid, ip); assert(r.allowed, 'limiter: attempt 1 allowed');
  r = await limiter.check(uid, ip); assert(r.allowed, 'limiter: attempt 2 allowed');
  r = await limiter.check(uid, ip); assert(r.allowed, 'limiter: attempt 3 allowed');
  r = await limiter.check(uid, ip);
  assert(!r.allowed && r.reason === 'attempt_limit',
    'limiter: attempt 4 blocked with attempt_limit');

  // Different user — fresh quota.
  const uid2 = 9999_0011;
  r = await limiter.check(uid2, '203.0.113.8');
  assert(r.allowed, 'limiter: different user gets fresh quota');

  // Cooldown trigger via recordFailure.
  const uid3 = 9999_0012;
  await limiter.check(uid3, '203.0.113.9');
  await limiter.recordFailure(uid3);
  await limiter.recordFailure(uid3); // hits FAILURE_LIMIT=2 → cooldown
  r = await limiter.check(uid3, '203.0.113.9');
  assert(!r.allowed && r.reason === 'cooldown',
    'limiter: cooldown engages after FAILURE_LIMIT failures');

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
