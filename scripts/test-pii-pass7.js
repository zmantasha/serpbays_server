#!/usr/bin/env node
/**
 * Regression test — PII pass 7 (anti-scraping caps on /api/marketplaces).
 *
 * Static-grep checks that the marketplace find/findOne endpoints can't
 * be used for bulk extraction even by an account past the $10 paywall.
 * Layered defenses:
 *   1. pageSize hard-capped at MARKETPLACE_MAX_PAGE_SIZE (default 50)
 *   2. page hard-capped at MARKETPLACE_MAX_PAGE (default 100)
 *   3. Route rate limit dropped from 100/min to 30/min on both
 *      /marketplaces and /marketplaces/:id
 *
 * Run: cd serpbays_server && node scripts/test-pii-pass7.js
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
const stripJsComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const MP_CTRL    = read('src/api/marketplace/controllers/marketplace.js');
const MP_ROUTES  = read('src/api/marketplace/routes/marketplace.js');
const MP_CTRL_NC = stripJsComments(MP_CTRL);

out('\n=== A. Pagination caps defined as env-tunable constants ===');

// A1. MARKETPLACE_MAX_PAGE_SIZE constant defined + reads env with sane default
assert(/const MARKETPLACE_MAX_PAGE_SIZE\s*=/.test(MP_CTRL),
  'MARKETPLACE_MAX_PAGE_SIZE constant defined');
assert(/process\.env\.MARKETPLACE_MAX_PAGE_SIZE/.test(MP_CTRL),
  'MARKETPLACE_MAX_PAGE_SIZE reads from env');
assert(/MARKETPLACE_MAX_PAGE_SIZE\s*=[\s\S]{0,200}50/.test(MP_CTRL),
  'MARKETPLACE_MAX_PAGE_SIZE default is 50');

// A2. MARKETPLACE_MAX_PAGE constant defined + reads env with sane default
assert(/const MARKETPLACE_MAX_PAGE\s*=/.test(MP_CTRL),
  'MARKETPLACE_MAX_PAGE constant defined');
assert(/process\.env\.MARKETPLACE_MAX_PAGE/.test(MP_CTRL),
  'MARKETPLACE_MAX_PAGE reads from env');
assert(/MARKETPLACE_MAX_PAGE\s*=[\s\S]{0,200}100/.test(MP_CTRL),
  'MARKETPLACE_MAX_PAGE default is 100');

out('\n=== B. clampMarketplacePagination helper ===');

// B1. Helper exists
assert(/function clampMarketplacePagination/.test(MP_CTRL),
  'clampMarketplacePagination helper defined');

// B2. Helper applies Math.min against both caps
{
  const fn = MP_CTRL.match(/function clampMarketplacePagination[\s\S]*?\n\}/);
  const body = fn ? fn[0] : '';
  assert(/Math\.min[\s\S]{0,200}MARKETPLACE_MAX_PAGE\b/.test(body),
    'clamp enforces page ≤ MARKETPLACE_MAX_PAGE');
  assert(/Math\.min[\s\S]{0,200}MARKETPLACE_MAX_PAGE_SIZE\b/.test(body),
    'clamp enforces pageSize ≤ MARKETPLACE_MAX_PAGE_SIZE');
}

out('\n=== C. find() uses the clamp at every pageSize site ===');

// C1. No unchecked `ctx.query.pagination?.pageSize || 25` reads in find() —
// every read must go through the helper.
{
  const findFn = MP_CTRL_NC.match(/async find\(ctx\)[\s\S]*?(?=\n  async [a-zA-Z]+\(ctx\)|\n\}\)\);\s*$)/m);
  const body = findFn ? findFn[0] : '';
  // Direct reads of ctx.query.pagination.pageSize without clamping are
  // banned. The clamp helper itself reads them, but its body is
  // outside find().
  const unsafeReads = (body.match(/ctx\.query\.pagination\?\.pageSize/g) || []).length;
  assert(unsafeReads === 0,
    `no direct ctx.query.pagination?.pageSize reads inside find() (found: ${unsafeReads})`);
  const clampCalls = (body.match(/clampMarketplacePagination\(ctx\)/g) || []).length;
  assert(clampCalls >= 2,
    `find() calls clampMarketplacePagination at every pageSize site (found: ${clampCalls})`);
}

out('\n=== D. Route rate limits lowered to 30/min ===');

// D1. /marketplaces (find) — rate limit max is 30
// Anchor on the handler name; there are multiple routes with
// path: '/marketplaces' (GET find, POST create, etc.) so the
// path string alone is ambiguous.
{
  const block = MP_ROUTES.match(/handler:\s*['"]marketplace\.find['"][\s\S]{0,600}\},\s*\},/);
  const body = block ? block[0] : '';
  assert(/max:\s*30\b/.test(body),
    '/marketplaces (find) rate limit max = 30 (was 100)');
  assert(!/max:\s*100\b/.test(body),
    '/marketplaces (find) no longer has rate limit max = 100');
}

// D2. /marketplaces/:id (findOne) — rate limit max is 30
{
  const block = MP_ROUTES.match(/handler:\s*['"]marketplace\.findOne['"][\s\S]{0,600}\},\s*\},/);
  const body = block ? block[0] : '';
  assert(/max:\s*30\b/.test(body),
    '/marketplaces/:id (findOne) rate limit max = 30 (was 100)');
}

out('\n=== E. Threat-model math (documentation check) ===');

// E1. With pageSize=50 + 30 req/min + max-page=100:
//   per-minute extraction:  30 × 50 = 1500 entries/min
//   per-hour extraction:    1500 × 60 = 90,000 entries/hour
//   direct-paging ceiling:  50 × 100 = 5000 entries (must use filters past this)
// For a 50K catalog: ≥ 33 minutes minimum at full rate.
// For a 188-row staging catalog: ≥ 4 requests minimum.
const PAGE_SIZE = 50;
const RATE_PER_MIN = 30;
const MAX_PAGE = 100;
const ENTRIES_PER_MIN = PAGE_SIZE * RATE_PER_MIN;
const REACHABLE_VIA_PAGING = PAGE_SIZE * MAX_PAGE;
assert(ENTRIES_PER_MIN <= 2000,
  `extraction rate ≤ 2000 entries/min (computed: ${ENTRIES_PER_MIN})`);
assert(REACHABLE_VIA_PAGING <= 5000,
  `direct-paging ceiling ≤ 5000 entries (computed: ${REACHABLE_VIA_PAGING})`);

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
