#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 4: publisher-website + marketplace.
 *
 * Closes:
 *   - CRITICAL: Magic-string admin-backdoor `user.email === 'mantasha@wordscloud.in'`
 *     in 11 sites across 4 controllers. Account compromise of that user
 *     would have granted platform-wide admin access. Now strict
 *     role.type ∈ {admin, super_admin} check only.
 *   - HIGH: publisher-website find/findOne/delete populated currentPublisherId
 *     (and originalPublisherId on find) as full up_users rows → password
 *     hash + withdrawalOtp + paypal_email leak. Populates narrowed to
 *     { fields: ['id'] }.
 *   - HIGH: publisher-website.findOne / .delete returned 403 on cross-tenant
 *     (enumeration). Now 404.
 *   - MEDIUM: checkClaimable (PUBLIC route) leaked publisherName +
 *     console-logged publisherEmail. Response narrowed to booleans + id/url;
 *     log lines stripped of PII.
 *   - CRITICAL: marketplace.update/delete only ran ownership check for
 *     `user.Advertiser === false`. Advertisers / plain users bypassed →
 *     could PUT / DELETE any marketplace listing (price tampering, mass
 *     delete). Now fail-CLOSED: admin OR matching-publisher only.
 *   - CRITICAL: marketplace.create accepted publisher_email = victim and
 *     auto-linked the victim's user FK → advertiser-as-publisher
 *     impersonation. Now strict: admin OR publisher (forced to own
 *     email + id).
 *   - MEDIUM: sanitizePublisherData didn't strip operational metadata
 *     (lastAhrefsRefreshAt, bulkRefreshSkipTools, approvalStatus, etc.).
 *     Now strips INTERNAL_FIELDS for non-owners.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass4.js
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
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const PW = read('src/api/publisher-website/controllers/publisher-website.js');
const MP = read('src/api/marketplace/controllers/marketplace.js');
const TX = read('src/api/transaction/controllers/transaction.js');
const EM = read('src/api/global/controllers/email-operations.js');
const WD = read('src/api/withdrawal-request/controllers/withdrawal-request.js');

out('\n=== 1) Magic-string admin backdoor removed everywhere ===');
const BACKDOOR = 'mantasha@wordscloud.in';
assert(!PW.includes(BACKDOOR), 'publisher-website.js: backdoor email absent');
assert(!MP.includes(BACKDOOR), 'marketplace.js: backdoor email absent');
assert(!TX.includes(BACKDOOR), 'transaction.js: backdoor email absent');
assert(!EM.includes(BACKDOOR), 'global/email-operations.js: backdoor email absent');
assert(!WD.includes(BACKDOOR), 'withdrawal-request.js: backdoor email absent');

out('\n=== 2) Admin gates use role.type and accept super_admin ===');
// Every isAdmin / hasAdminAccess construct in the touched files should
// include role.type === 'super_admin' (not just 'admin'), because the
// super_admin role exists in production (id=4).
for (const [name, body] of [['publisher-website', PW], ['transaction', TX], ['global/email-operations', EM], ['withdrawal-request', WD]]) {
  // Capture full expression up to first semicolon — admin checks may span
  // multiple lines (const isAdmin = user && user.role && (\n  ... )).
  const adminAssignments = body.match(/(?:isAdmin|hasAdminAccess)\s*=\s*[\s\S]+?;/g) || [];
  if (adminAssignments.length > 0) {
    const allInclude = adminAssignments.every(a => /super_admin/.test(a));
    assert(allInclude, `${name}.js: every admin-check includes 'super_admin' (${adminAssignments.length} site(s))`);
  } else {
    pass++; out('  ✅', `${name}.js: no isAdmin/hasAdminAccess sites (or already strict)`);
  }
}

out('\n=== 3) publisher-website: find populates id-only on user relations ===');
assert(/populate:\s*\{[\s\S]{0,300}currentPublisherId:\s*\{\s*(select|fields):\s*\['id'\]\s*\}[\s\S]{0,200}originalPublisherId:\s*\{\s*(select|fields):\s*\['id'\]\s*\}/.test(PW),
  'find populates currentPublisherId + originalPublisherId with {id} only');
// findOne and delete narrowed too
const pwFindOneStart = PW.indexOf('async findOne(ctx)');
const pwFindOneEnd   = PW.indexOf('async update(ctx)', pwFindOneStart);
const pwFindOne      = pwFindOneStart > 0 && pwFindOneEnd > pwFindOneStart ? PW.slice(pwFindOneStart, pwFindOneEnd) : '';
assert(/populate:\s*\{\s*currentPublisherId:\s*\{\s*fields:\s*\['id'\]\s*\}\s*\}/.test(pwFindOne),
  'findOne populates currentPublisherId with {id} only');
assert(/if\s*\(\s*!isOwner\s*\)[\s\S]{0,200}ctx\.notFound/.test(pwFindOne),
  'findOne returns 404 (not 403) on cross-tenant');
const pwDeleteStart = PW.indexOf('async delete(ctx)');
const pwDeleteEnd   = PW.indexOf('async gscVerifyInit(ctx)', pwDeleteStart);
const pwDelete      = pwDeleteStart > 0 && pwDeleteEnd > pwDeleteStart ? PW.slice(pwDeleteStart, pwDeleteEnd) : '';
assert(/populate:\s*\{\s*currentPublisherId:\s*\{\s*fields:\s*\['id'\]\s*\}\s*\}/.test(pwDelete),
  'delete populates currentPublisherId with {id} only');
assert(/!isPublisherWebsiteOwner\([\s\S]{0,80}ctx\.notFound/.test(pwDelete),
  'delete returns 404 (not 403) on cross-tenant');

out('\n=== 4) publisher-website.checkClaimable — PII redacted ===');
const ccStart = PW.indexOf('async checkClaimable(ctx)');
const ccEnd   = PW.indexOf('async delete(ctx)', ccStart);
const cc      = ccStart > 0 && ccEnd > ccStart ? PW.slice(ccStart, ccEnd) : '';
// Strip JS line-comments so explanatory comments mentioning the old
// behaviour don't false-positive.
const ccCode = cc.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/publisherName/.test(ccCode),
  'response no longer references publisherName (code, comments excluded)');
assert(!/publisherEmail:\s*w\.publisherEmail/.test(ccCode),
  'no longer console-logs publisherEmail');
// Allowed in response: exists, claimable, isGSCVerified, data.id, data.url
assert(/claimable:\s*!isGSCVerified/.test(cc),
  'response carries claimable boolean');
assert(/data:\s*\{[\s\S]{0,100}id:\s*website\.id,[\s\S]{0,80}url:\s*website\.url[\s\S]{0,40}\}/.test(cc),
  'response.data = { id, url } only (no publisher PII)');
// No leak of verificationMethod / submissionStatus / addedByReseller
assert(!/verificationMethod:\s*website\.verificationMethod/.test(cc),
  'verificationMethod not leaked in response');
assert(!/currentStatus:\s*website\.submissionStatus/.test(cc),
  'submissionStatus not leaked in response');

out('\n=== 5) marketplace.create — admin OR publisher (no advertiser impersonation) ===');
const mpCreateStart = MP.indexOf('async create(ctx)');
const mpCreateEnd   = MP.indexOf('async update(ctx)', mpCreateStart);
const mpCreate      = mpCreateStart > 0 && mpCreateEnd > mpCreateStart ? MP.slice(mpCreateStart, mpCreateEnd) : '';
assert(/const\s+isAdmin\s*=\s*user\.role\s*&&\s*\(\s*user\.role\.type\s*===\s*'admin'\s*\|\|\s*user\.role\.type\s*===\s*'super_admin'\s*\)/.test(mpCreate),
  'create defines isAdmin via role.type only');
assert(/if\s*\(\s*!isAdmin\s*&&\s*!isPublisher\s*\)[\s\S]{0,150}ctx\.forbidden/.test(mpCreate),
  'create forbids when user is neither admin nor publisher');
assert(/if\s*\(\s*!isAdmin\s*\)[\s\S]{0,300}publisher_email\s*=\s*user\.email[\s\S]{0,150}publisher\s*=\s*user\.id/.test(mpCreate),
  'create forces publisher_email + publisher to caller (no impersonation)');

out('\n=== 6) marketplace.update — fail-CLOSED ownership for non-admins ===');
const mpUpdateStart = MP.indexOf('async update(ctx)');
const mpUpdateEnd   = MP.indexOf('async delete(ctx)', mpUpdateStart);
const mpUpdate      = mpUpdateStart > 0 && mpUpdateEnd > mpUpdateStart ? MP.slice(mpUpdateStart, mpUpdateEnd) : '';
assert(/if\s*\(\s*!isAdmin\s*&&\s*!isPublisher\s*\)[\s\S]{0,150}ctx\.forbidden/.test(mpUpdate),
  'update forbids advertisers (closes the prior write-IDOR)');
assert(/if\s*\(\s*!isAdmin\s*\)[\s\S]{0,400}isOwner[\s\S]{0,400}ctx\.notFound/.test(mpUpdate),
  'update returns 404 (not 401) on non-owner publisher');

out('\n=== 7) marketplace.delete — fail-CLOSED ownership for non-admins ===');
const mpDeleteStart = MP.indexOf('async delete(ctx)');
const mpDeleteEnd   = MP.indexOf('async find(ctx)', mpDeleteStart);
const mpDelete      = mpDeleteStart > 0 && mpDeleteEnd > mpDeleteStart ? MP.slice(mpDeleteStart, mpDeleteEnd) : '';
assert(/if\s*\(\s*!isAdmin\s*&&\s*!isPublisher\s*\)[\s\S]{0,150}ctx\.forbidden/.test(mpDelete),
  'delete forbids advertisers (closes the prior delete-IDOR)');
assert(/if\s*\(\s*!isAdmin\s*\)[\s\S]{0,400}isOwner[\s\S]{0,400}ctx\.notFound/.test(mpDelete),
  'delete returns 404 (not 401) on non-owner publisher');

out('\n=== 8) sanitizePublisherData strips operational metadata + GSC for non-owners ===');
const spdStart = MP.indexOf('sanitizePublisherData(entries, user)');
const spdEnd   = MP.indexOf('calculatePlacementSpeed(tat)');
const spd      = spdStart > 0 && spdEnd > spdStart ? MP.slice(spdStart, spdEnd) : '';
assert(/delete\s+sanitized\.gsc_refresh_token/.test(spd),
  'always strips gsc_refresh_token (regardless of ownership)');
assert(/delete\s+sanitized\.gsc_permission_level/.test(spd),
  'strips gsc_permission_level for non-owners');
assert(/const\s+INTERNAL_FIELDS\s*=\s*\[/.test(spd),
  'INTERNAL_FIELDS strip list defined');
for (const f of [
  'approvalStatus', 'blacklist_status',
  'lastAhrefsRefreshAt', 'lastMozRefreshAt', 'lastSemrushRefreshAt',
  'lastAhrefsExportAt', 'lastMozExportAt', 'lastSemrushExportAt',
  'bulkRefreshSkipTools', 'dataVersion', 'delistedReason', 'delistedAt',
]) {
  assert(new RegExp(`['"]${f}['"]`).test(spd), `${f} in INTERNAL_FIELDS strip list`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
