#!/usr/bin/env node
/**
 * Regression test — affiliate Phase 1 (core flow).
 *
 * Locks in the security posture for:
 *   A. Referral-code generation (crypto-random, unique, normalised)
 *   B. Public click endpoint (auth:false, rate-limited, IP-hashed, uniform response)
 *   C. Authenticated user-facing endpoints (apply / me / regenerate / referrals / stats)
 *   D. Admin endpoints (list / disable / enable / regenerate / terminate)
 *   E. Clerk-sync attribution hook + self-referral guards
 *   F. Schemas (private fields, unique constraints)
 *
 * Static-grep + functional check. Run:
 *   cd serpbays_server && node scripts/test-affiliate-pass1.js
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

const PROFILE_SCHEMA  = read('src/api/affiliate-profile/content-types/affiliate-profile/schema.json');
const REFERRAL_SCHEMA = read('src/api/affiliate-referral/content-types/affiliate-referral/schema.json');
const CLICK_SCHEMA    = read('src/api/affiliate-link-click/content-types/affiliate-link-click/schema.json');
const CODE_UTIL       = read('src/utils/referral-code.js');
const CLICK_LIMITER   = read('src/utils/affiliate-click-limiter.js');
const ATTRIB_SVC      = read('src/api/affiliate-profile/services/affiliate-attribution.js');
const CLICK_CTRL      = read('src/api/affiliate-link-click/controllers/affiliate-link-click.js');
const CLICK_ROUTE     = read('src/api/affiliate-link-click/routes/affiliate-link-click.js');
const USER_CTRL       = read('src/api/affiliate-profile/controllers/affiliate-profile.js');
const USER_ROUTE      = read('src/api/affiliate-profile/routes/affiliate-profile.js');
const ADMIN_CTRL      = read('src/api/admin/controllers/affiliates.js');
const ADMIN_ROUTE     = read('src/api/admin/routes/affiliates.js');
const CLERK           = read('src/api/auth/controllers/clerk.js');

out('\n=== A. Referral-code generator ===');

assert(/const crypto = require\('crypto'\)/.test(CODE_UTIL),
  'referral-code util uses Node crypto (CSPRNG)');
assert(!/Math\.random/.test(CODE_UTIL),
  'referral-code util does NOT use Math.random');
assert(/ALPHABET\s*=\s*['"]0123456789ABCDEFGHJKMNPQRSTVWXYZ['"]/.test(CODE_UTIL),
  'uses Crockford base32 (no I/L/O/U)');
assert(/generateUniqueCode/.test(CODE_UTIL),
  'exports generateUniqueCode with collision retry');
assert(/normaliseCode/.test(CODE_UTIL),
  'exports normaliseCode for lookup');

out('\n=== B. Click endpoint — public but locked down ===');

assert(/auth:\s*false/.test(CLICK_ROUTE),
  'click endpoint route is auth:false (visitors haven\'t signed up yet)');
assert(/'\/affiliate-tracking\/click'/.test(CLICK_ROUTE),
  'click endpoint mounted at /affiliate-tracking/click');
assert(/limiter\.check|affiliate-click-limiter/.test(CLICK_CTRL),
  'click controller invokes the rate limiter');
assert(/hashIp|ipHash|createHash\('sha256'\)/.test(CLICK_CTRL),
  'click controller hashes IP (raw IP never stored)');
assert(/ctx\.status\s*=\s*204/.test(CLICK_CTRL),
  'click controller returns 204 (uniform response — no code-existence oracle)');
assert(/normaliseCode/.test(CLICK_CTRL),
  'click controller normalises the code before DB lookup');
assert(/query-string stripped|indexOf\('\?'\)/.test(CLICK_CTRL),
  'click controller strips query string from landingPath (no auth-token leak)');

// Limiter has both per-IP and per-code layers.
assert(/AFFILIATE_CLICK_IP_LIMIT/.test(CLICK_LIMITER),
  'click limiter reads AFFILIATE_CLICK_IP_LIMIT env');
assert(/AFFILIATE_CLICK_CODE_LIMIT/.test(CLICK_LIMITER),
  'click limiter reads AFFILIATE_CLICK_CODE_LIMIT env');
assert(/global\.strapi\?\.io_redis\?\.pubClient/.test(CLICK_LIMITER),
  'click limiter uses shared Redis with in-memory fallback');

out('\n=== C. Authenticated user-facing endpoints ===');

// All 5 handlers exist + read ctx.state.user.id.
for (const handler of ['apply', 'me', 'regenerateMyCode', 'myReferrals', 'myStats']) {
  const idx = USER_CTRL.indexOf('async ' + handler + '(ctx)');
  assert(idx >= 0, `affiliate-profile controller defines ${handler}`);
  const body = idx >= 0 ? USER_CTRL.slice(idx, idx + 3000) : '';
  assert(/ctx\.state\.user/.test(body),
    `${handler} reads ctx.state.user`);
}

// Routes are all POST/GET; no default /affiliate-profiles routes (which
// would allow enumeration via GET /affiliate-profiles).
assert(!/api::affiliate-profile\.affiliate-profile\.(find|findOne|create|update|delete)/.test(USER_ROUTE),
  'user-facing routes do NOT expose default find/findOne/create — only the 5 custom endpoints');

// Ownership binding — profile.user is set from ctx.state.user.id, never body.
{
  const applyIdx = USER_CTRL.indexOf('async apply(ctx)');
  const body = USER_CTRL.slice(applyIdx, applyIdx + 2000);
  assert(/user:\s*userId/.test(body),
    'apply() binds profile.user = ctx.state.user.id (not from body)');
  assert(!/user:\s*ctx\.request\.body|user:\s*body\./.test(body),
    'apply() does NOT accept a body-supplied user');
}

// Self-service code rotation is throttled.
assert(/CODE_ROTATION_COOLDOWN_S/.test(USER_CTRL),
  'regenerateMyCode enforces a cooldown between rotations');

// myReferrals never leaks referred-user PII.
{
  const idx = USER_CTRL.indexOf('async myReferrals(ctx)');
  const body = USER_CTRL.slice(idx, idx + 2500);
  assert(/referredUser:\s*\{\s*fields:\s*\['id'\]\s*\}/.test(body),
    'myReferrals populates referredUser as id-only (no email/username leak)');
}

// pageSize cap on myReferrals (same pass-9 pattern).
{
  const idx = USER_CTRL.indexOf('async myReferrals(ctx)');
  const body = USER_CTRL.slice(idx, idx + 2500);
  assert(/Math\.min\(rawSize,\s*100\)/.test(body),
    'myReferrals caps pageSize at 100');
}

out('\n=== D. Admin endpoints ===');

// Every admin route is gated by is-admin + admin-jwt-auth.
for (const path of ['/admin/affiliates', '/admin/affiliates/:id/disable', '/admin/affiliates/:id/enable', '/admin/affiliates/:id/regenerate-code', '/admin/affiliates/:id/terminate']) {
  assert(ADMIN_ROUTE.includes(path),
    `admin route ${path} registered`);
}
const adminRoutesCount = (ADMIN_ROUTE.match(/policies:\s*\['global::is-admin'\]/g) || []).length;
assert(adminRoutesCount >= 7,
  `every admin affiliate route gated by global::is-admin policy (count: ${adminRoutesCount})`);
const adminMwCount = (ADMIN_ROUTE.match(/middlewares:\s*\['global::admin-jwt-auth'\]/g) || []).length;
assert(adminMwCount >= 7,
  `every admin affiliate route uses global::admin-jwt-auth middleware (count: ${adminMwCount})`);

// terminate is one-way.
{
  const idx = ADMIN_CTRL.indexOf('async terminate(ctx)');
  const body = ADMIN_CTRL.slice(idx, idx + 2000);
  assert(/status:\s*['"]terminated['"]/.test(body),
    'terminate sets status = "terminated"');
}
{
  const idx = ADMIN_CTRL.indexOf('async enable(ctx)');
  const body = ADMIN_CTRL.slice(idx, idx + 2000);
  assert(/terminated.*Cannot re-enable a terminated/.test(body) ||
         /Cannot re-enable a terminated/.test(body),
    'enable() refuses to re-enable a terminated affiliate');
}

out('\n=== E. Clerk-sync attribution hook + self-referral guards ===');

// The sync handler accepts referralCode from the body.
assert(/referralCode\s*}\s*=\s*ctx\.request\.body|referralCode,\s*}\s*=\s*ctx\.request\.body|referralCode\s*}\s*=\s*ctx\.request/.test(CLERK) ||
       /const\s*\{[^}]*referralCode[^}]*\}\s*=\s*ctx\.request\.body/.test(CLERK),
  'clerk sync destructures referralCode from ctx.request.body');

// The attribution service is called only inside the new-user-create branch.
assert(/attributeReferral/.test(CLERK),
  'clerk sync calls attributeReferral');
{
  // Attribution should be inside the try-block that follows user creation,
  // NOT inside the update path. Rough check: attributeReferral is invoked
  // after the "User created successfully" log line.
  const createdIdx = CLERK.indexOf('User created successfully');
  const attribIdx  = CLERK.indexOf('attributeReferral');
  assert(createdIdx >= 0 && attribIdx > createdIdx,
    'attribution fires only after fresh user create (not on update path)');
}
assert(/attribution failed \(non-fatal\)|attribution.*non-fatal/i.test(CLERK),
  'attribution errors are swallowed — signup still succeeds');

// The service enforces self-referral guards.
assert(/SELF-REFERRAL blocked.*same user id|affiliate\.user\.id\s*===\s*userId/.test(ATTRIB_SVC),
  'attribution service rejects self-referral by user.id');
assert(/SELF-REFERRAL blocked.*same email|userEmail\.toLowerCase\(\)\s*===\s*affiliate\.user\.email/.test(ATTRIB_SVC),
  'attribution service rejects self-referral by email match');
assert(/ip_hash match|winningClick\.ipHash\s*===\s*signupIpHash/.test(ATTRIB_SVC),
  'attribution service flags IP-hash matches as blocked (possible self-referral)');

// Idempotency guard.
assert(/referredUser\s*already has a referral|existing/i.test(ATTRIB_SVC) &&
       /findOne\([\s\S]{0,200}referredUser:\s*userId/.test(ATTRIB_SVC),
  'attribution service is idempotent on referredUser');

// Attribution window enforced.
assert(/AFFILIATE_ATTRIBUTION_WINDOW_DAYS|ATTRIBUTION_WINDOW_DAYS/.test(ATTRIB_SVC),
  'attribution service enforces an eligibility window on click age');

// Only active affiliates attribute.
assert(/status:\s*['"]active['"]/.test(ATTRIB_SVC),
  'attribution service only resolves active affiliates');

out('\n=== F. Schema safety — private fields + unique constraints ===');

const P = (() => { try { return JSON.parse(PROFILE_SCHEMA);  } catch { return {}; } })();
const R = (() => { try { return JSON.parse(REFERRAL_SCHEMA); } catch { return {}; } })();
const C = (() => { try { return JSON.parse(CLICK_SCHEMA);    } catch { return {}; } })();

assert(P?.attributes?.referralCode?.unique === true,
  'affiliate-profile.referralCode is UNIQUE (no code collisions in DB)');
assert(P?.attributes?.referralCode?.required === true,
  'affiliate-profile.referralCode is REQUIRED');
assert(Array.isArray(P?.options?.privateAttributes) && P.options.privateAttributes.includes('disabledReason'),
  'affiliate-profile.disabledReason listed in privateAttributes');
assert(P?.attributes?.disabledReason?.private === true,
  'affiliate-profile.disabledReason.private = true');
assert(P?.attributes?.adminNotes?.private === true,
  'affiliate-profile.adminNotes.private = true');

assert(R?.attributes?.attributionIpHash?.private === true,
  'affiliate-referral.attributionIpHash.private = true (never exposed)');
assert(R?.attributes?.adminNotes?.private === true,
  'affiliate-referral.adminNotes.private = true');
// The referredUser relation is oneToOne (which yields a UNIQUE constraint
// on the FK column in the underlying DB, preventing re-attribution).
assert(R?.attributes?.referredUser?.relation === 'oneToOne',
  'affiliate-referral.referredUser is oneToOne (UNIQUE — one referral per user)');

assert(C?.attributes?.ipHash?.private === true,
  'affiliate-link-click.ipHash.private = true');
assert(C?.attributes?.userAgent?.private === true,
  'affiliate-link-click.userAgent.private = true');

out('\n=== G. Functional check — code generator + normaliser ===');

(async () => {
  const codeUtil = require('/var/www/serpbays/serpbays_server/src/utils/referral-code');
  // Generate 100 codes; every one must be 10 chars from the alphabet, and
  // there should be no duplicates.
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const c = codeUtil.generateCode();
    if (c.length !== 10) { fail++; out('  FAIL', 'generated code wrong length'); break; }
    for (const ch of c) {
      if (codeUtil.ALPHABET.indexOf(ch) === -1) { fail++; out('  FAIL', 'generated char outside alphabet'); break; }
    }
    if (seen.has(c)) { fail++; out('  FAIL', 'duplicate in 100 generated codes'); break; }
    seen.add(c);
  }
  assert(seen.size === 100, 'generated 100 unique codes (100/100)');

  // normaliseCode round-trip
  const raw = codeUtil.generateCode();
  assert(codeUtil.normaliseCode(raw) === raw,
    'normaliseCode idempotent on freshly-generated codes');
  assert(codeUtil.normaliseCode(raw.toLowerCase()) === raw,
    'normaliseCode uppercases lowercase input');
  assert(codeUtil.normaliseCode(' ' + raw + ' ') === raw,
    'normaliseCode trims whitespace');
  assert(codeUtil.normaliseCode('') === null,
    'normaliseCode rejects empty string');
  assert(codeUtil.normaliseCode('short') === null,
    'normaliseCode rejects wrong length');
  assert(codeUtil.normaliseCode('ABCDEFGH!@') === null,
    'normaliseCode rejects invalid chars');
  // Crockford dedup — O→0, I→1
  const withZeros = raw.replace(/./, '0'); // ensure has a 0
  const withO = withZeros.replace('0', 'O');
  assert(codeUtil.normaliseCode(withO) === withZeros,
    'normaliseCode maps O→0 (Crockford)');

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
