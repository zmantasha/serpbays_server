#!/usr/bin/env node
/**
 * Regression test: GET /api/projects/my/all (getMyProjects).
 *
 * Pre-fix (CRITICAL):
 *   populate: ['owner', 'team', 'orders', 'files'] returned the FULL up_users
 *   row for owner + every team member (password hash, resetPasswordToken,
 *   confirmationToken, *active* withdrawalOtp/Expiry/Amount/Attempts, PayPal /
 *   Payoneer payout emails, billing address, phone, VAT/GST, clerk_id,
 *   tokenVersion, pagePermissions, marketplace_unlock_reason). `private: true`
 *   in the schema is only enforced by sanitizeOutput; the handler returned
 *   the raw findMany result. The orders relation also returned every column
 *   on every order (including snapshot publisher PII).
 *
 * Post-fix:
 *   - Each populated relation has an explicit `fields:` allow-list
 *   - Top-level project response is also fields-allowlisted
 *   - pageSize hard-capped at 100; non-numeric falls back to 9; page>=1
 *   - Auth still required
 *
 * Static-grep test — no Strapi load.
 *
 * Run: cd serpbays_server && node scripts/test-projects-my-all-authz.js
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

const CTRL = read('src/api/project/controllers/project.js');
const ROUTE = read('src/api/project/routes/project.js');

// Slice getMyProjects only
const start = CTRL.indexOf('async getMyProjects(ctx)');
const end   = CTRL.indexOf('async getTemplates(ctx)');
const body  = start > 0 && end > start ? CTRL.slice(start, end) : '';

out('\n=== 1) Route still registered with is-authenticated policy ===');
assert(/path:\s*'\/projects\/my\/all'/.test(ROUTE), 'route /projects/my/all exists');
assert(/handler:\s*'api::project\.project\.getMyProjects'/.test(ROUTE),
  'handler is api::project.project.getMyProjects');
assert(/policies:\s*\['api::project\.is-authenticated'\]/.test(ROUTE),
  'policy is api::project.is-authenticated (rejects anonymous)');

out('\n=== 2) getMyProjects body extracted ===');
assert(body.length > 0, 'handler body sliced');

out('\n=== 3) Authentication check ===');
assert(/if\s*\(\s*!user\s*\)[\s\S]{0,80}ctx\.unauthorized/.test(body),
  'rejects unauthenticated callers');

out('\n=== 4) Ownership filter — owner OR team-membership only ===');
assert(/\$or:\s*\[[\s\S]{0,200}\{\s*owner:\s*user\.id\s*\}/.test(body),
  '$or includes { owner: user.id }');
assert(/\$or:\s*\[[\s\S]{0,200}\{\s*team:\s*\{\s*id:\s*user\.id\s*\}\s*\}/.test(body),
  '$or includes { team: { id: user.id } }');

out('\n=== 5) CRITICAL — populate is field-allow-listed (no full-user / full-order leak) ===');
// The old code had `populate: ['owner', 'team', 'orders', 'files']`. Forbid.
assert(!/populate:\s*\[\s*'owner'\s*,\s*'team'\s*,\s*'orders'\s*,\s*'files'\s*\]/.test(body),
  'string-array populate gone (the previous all-fields leak path)');
// The new code MUST shape populate as { owner: { fields: [...] }, ... }
assert(/populate:\s*\{[\s\S]{0,800}owner:\s*\{\s*fields:\s*\[[^\]]+\]\s*\}/.test(body),
  'owner populated with explicit fields:[...]');
assert(/populate:\s*\{[\s\S]{0,800}team:\s*\{\s*fields:\s*\[[^\]]+\]\s*\}/.test(body),
  'team populated with explicit fields:[...]');
assert(/populate:\s*\{[\s\S]{0,800}orders:\s*\{\s*fields:\s*\[[^\]]+\]\s*\}/.test(body),
  'orders populated with explicit fields:[...]');
assert(/populate:\s*\{[\s\S]{0,800}files:\s*\{\s*fields:\s*\[[^\]]+\]\s*\}/.test(body),
  'files populated with explicit fields:[...]');

out('\n=== 6) CRITICAL — sensitive user columns NEVER in the owner/team allow-list ===');
const ownerMatch = body.match(/owner:\s*\{\s*fields:\s*\[([^\]]+)\]/);
const teamMatch  = body.match(/team:\s*\{\s*fields:\s*\[([^\]]+)\]/);
const ownerFields = ownerMatch ? ownerMatch[1] : '';
const teamFields  = teamMatch ? teamMatch[1] : '';
const FORBIDDEN_USER_FIELDS = [
  // auth secrets
  'password', 'resetPasswordToken', 'confirmationToken',
  // withdrawal OTP — leaks would enable wallet drain
  'withdrawalOtp', 'withdrawalOtpExpiry', 'withdrawalOtpAmount',
  'withdrawalOtpAttempts', 'withdrawalOtpSentAt',
  // payout destinations
  'paypal_email', 'paypalEmail', 'payoneer_email', 'payoneerEmail',
  // PII
  'billing_address', 'billingAddress', 'phone_number', 'phoneNumber',
  'vat_gst_number', 'vatGstNumber', 'registration_number', 'registrationNumber',
  // identity / JWT-version
  'clerk_id', 'clerkId', 'token_version', 'tokenVersion',
  // admin/internal state
  'pagePermissions', 'marketplace_unlock_reason', 'marketplaceUnlockReason',
  'marketplace_unlocked_by', 'marketplaceUnlockedBy',
];
for (const banned of FORBIDDEN_USER_FIELDS) {
  assert(!new RegExp(`['"]${banned}['"]`).test(ownerFields),
    `owner allow-list excludes '${banned}'`);
  assert(!new RegExp(`['"]${banned}['"]`).test(teamFields),
    `team allow-list excludes '${banned}'`);
}

out('\n=== 7) Top-level project fields are allow-listed ===');
assert(/fields:\s*\[[\s\S]{0,200}'ProjectName'/.test(body),
  'top-level fields allow-list includes ProjectName');
assert(/fields:\s*\[[\s\S]{0,300}'projectUrl'/.test(body),
  'top-level fields allow-list includes projectUrl');
assert(/fields:\s*\[[\s\S]{0,300}'status'/.test(body),
  'top-level fields allow-list includes status');

out('\n=== 8) Pagination caps + sanitization ===');
assert(/Number\.parseInt\s*\(\s*pagination\?\.page/.test(body),
  'page parsed with parseInt');
assert(/Number\.parseInt\s*\(\s*pagination\?\.pageSize/.test(body),
  'pageSize parsed with parseInt');
assert(/Math\.min\s*\(\s*rawPageSize\s*,\s*100\s*\)/.test(body),
  'pageSize hard-capped at 100 (DoS defense)');
assert(/rawPage\s*>=\s*1/.test(body) || />=\s*1\s*\?\s*rawPage/.test(body),
  'page ≥ 1 enforced');
assert(/Number\.isFinite\s*\(\s*rawPage\s*\)/.test(body),
  'page validated as finite number (rejects NaN)');
assert(/Number\.isFinite\s*\(\s*rawPageSize\s*\)/.test(body),
  'pageSize validated as finite number (rejects NaN)');

out('\n=== 9) Pagination structure preserved (frontend contract) ===');
assert(/meta:\s*\{[\s\S]{0,300}pagination:\s*\{[\s\S]{0,200}page,[\s\S]{0,80}pageSize,[\s\S]{0,80}pageCount,[\s\S]{0,80}total/.test(body),
  'meta.pagination { page, pageSize, pageCount, total } returned');

out('\n=== 10) Error path does not leak error.message back to caller ===');
// Pre-fix returned { error: error.message } in the response — could leak
// SQL state, table names, etc. New code logs server-side; returns generic.
assert(!/badRequest\s*\(\s*'Failed to fetch projects'[^)]*error:\s*error\.message/.test(body),
  'error.message NOT echoed in response (server-side log only)');

// ---------------------------------------------------------------------------
// Adjacent IDOR fixes — same controller file, separate handlers
// ---------------------------------------------------------------------------

const getAnalyticsStart = CTRL.indexOf('async getAnalytics(ctx)');
const getAnalyticsEnd   = CTRL.indexOf('async updateMetrics(ctx)');
const analyticsBody = getAnalyticsStart > 0 && getAnalyticsEnd > getAnalyticsStart
  ? CTRL.slice(getAnalyticsStart, getAnalyticsEnd)
  : '';

const updateMetricsStart = CTRL.indexOf('async updateMetrics(ctx)');
const updateMetricsEnd   = CTRL.indexOf('async update(ctx)');
const metricsBody = updateMetricsStart > 0 && updateMetricsEnd > updateMetricsStart
  ? CTRL.slice(updateMetricsStart, updateMetricsEnd)
  : '';

out('\n=== 11) getAnalytics — auth + ownership check (read-IDOR fix) ===');
assert(analyticsBody.length > 0, 'getAnalytics body sliced');
assert(/if\s*\(\s*!user\s*\)[\s\S]{0,80}ctx\.unauthorized/.test(analyticsBody),
  'getAnalytics rejects unauthenticated');
assert(/project\.owner\?\.id\s*===\s*user\.id/.test(analyticsBody),
  'getAnalytics checks project.owner.id === user.id');
assert(/project\.team[\s\S]{0,200}\.some\([\s\S]{0,80}===\s*user\.id/.test(analyticsBody),
  'getAnalytics checks team membership');
assert(/if\s*\(\s*!hasAccess\s*\)[\s\S]{0,80}ctx\.notFound/.test(analyticsBody),
  'getAnalytics returns 404 on no-access (not 403 — defeats enumeration)');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(analyticsBody),
  'getAnalytics validates id as positive integer');
assert(/populate:\s*\{[\s\S]{0,300}owner:\s*\{\s*fields:\s*\['id'\]\s*\}/.test(analyticsBody),
  'getAnalytics populates owner with fields:[id] only');
assert(!/badRequest\s*\(\s*'Failed to fetch analytics'[^)]*error\.message/.test(analyticsBody),
  'getAnalytics does NOT echo error.message in response');

out('\n=== 12) updateMetrics — auth + owner-only + input validation (write-IDOR fix) ===');
assert(metricsBody.length > 0, 'updateMetrics body sliced');
assert(/if\s*\(\s*!user\s*\)[\s\S]{0,80}ctx\.unauthorized/.test(metricsBody),
  'updateMetrics rejects unauthenticated');
assert(/project\.owner\?\.id\s*!==\s*user\.id/.test(metricsBody),
  'updateMetrics checks owner FK (owner-only write)');
// Owner-only: no team allowance for writes
assert(!/team[\s\S]{0,200}\.some\(/.test(metricsBody),
  'updateMetrics does NOT allow team members to write (owner-only)');
assert(/typeof\s+metrics\s*!==\s*'object'\s*\|\|\s*Array\.isArray\(metrics\)/.test(metricsBody),
  'updateMetrics rejects non-object / array metrics');
assert(/!metrics\b/.test(metricsBody),
  'updateMetrics rejects null/undefined metrics');
assert(/if\s*\(\s*project\.owner\?\.id\s*!==\s*user\.id\s*\)[\s\S]{0,80}ctx\.notFound/.test(metricsBody),
  'updateMetrics returns 404 on non-owner (not 403 — defeats enumeration)');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(metricsBody),
  'updateMetrics validates id as positive integer');
// Response shape: only id + metrics, no full project leak
assert(/data:\s*\{[\s\S]{0,120}id:\s*updatedProject\.id[\s\S]{0,120}metrics:\s*updatedProject\.metrics/.test(metricsBody),
  'updateMetrics returns only { id, metrics } (no full entity leak)');
assert(!/badRequest\s*\(\s*'Failed to update metrics'[^)]*error\.message/.test(metricsBody),
  'updateMetrics does NOT echo error.message in response');
assert(!/console\.log/.test(metricsBody),
  'updateMetrics no longer console.log(id) — was leaking id to server logs');

out('\n=== 13) Dead unauthenticated customController removed from routes/project.js ===');
assert(!/const\s+customController\s*=\s*\(\s*\{\s*strapi\s*\}\s*\)\s*=>/.test(ROUTE),
  'dead `customController` function block removed (preventing future accidental wiring)');
assert(!/sanitizeOutput\(entity,\s*ctx\)[\s\S]{0,80}transformResponse/.test(ROUTE),
  'unauthenticated findOne body removed from routes/project.js');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
