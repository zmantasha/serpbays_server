#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 13: workflow remaining IDORs (chatroom
 * transcript / conversation, publisher-website admin-approval, marketplace
 * TAT/history).
 *
 * Findings closed (workflow IDs):
 *   - HIGH (idor-chatroom-transcript): downloadTranscript had NO auth check
 *     and NO party check. Authenticated has the permission grant, so any
 *     logged-in user could GET /chatrooms/<N>/transcript and download any
 *     chatroom's full conversation including both parties' emails + (via
 *     populate) the full up_users rows for sender/advertiser/publisher.
 *     Now: auth gate + party check + 404 on non-party + allow-listed
 *     populate ({id, username, email} on users; no password hash / OTPs).
 *   - HIGH (idor-chatroom-fullconv): getFullConversation had same defect.
 *     Same fix applied.
 *   - HIGH (qa3-leak-chatroom-getorcreate): getOrCreateChatroom had auth +
 *     ownership check, but populate returned full up_users rows on
 *     advertiser/publisher/communications.sender. Now allow-listed.
 *   - HIGH (idor-publisher-approval-status): admin-approval.getApprovalStatus
 *     had NO ownership check. Authenticated has the grant so any logged-in
 *     user could probe any submission's approvalStatus / approvedAt /
 *     reviewedBy. Competitor-recon vector. Now admin-OR-owner; 404 on
 *     cross-tenant.
 *   - DEFENSE-IN-DEPTH (idor-publisher-manual-approve / mw-find-manualApprove-no-admin-check):
 *     admin-approval.manualApprove had NO in-handler admin check. Currently
 *     only super_admin has the permission grant, but a future permission
 *     change would have exposed wallet-revenue creation (approval triggers
 *     marketplace listing creation). Defense-in-depth admin check added.
 *   - HIGH (idor-marketplace-update-tat): marketplace.updateTAT ownership
 *     check only ran for publishers (user.Advertiser === false).
 *     Advertisers / plain users bypassed → write IDOR on any listing's
 *     placement_speed. Now fail-CLOSED.
 *   - HIGH (idor-marketplace-history): marketplace.getUpdateHistory had
 *     NO ownership check. Any auth user could read any listing's audit
 *     trail. Now admin-OR-owner; 404 on cross-tenant.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass13.js
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

const CR  = read('src/api/chatroom/controllers/chatroom.js');
const AA  = read('src/api/publisher-website/controllers/admin-approval.js');
const MP  = read('src/api/marketplace/controllers/marketplace.js');

out('\n=== 1) chatroom.downloadTranscript — auth + party check + allow-list ===');
const dtStart = CR.indexOf('async downloadTranscript(ctx)');
const dtEnd   = CR.indexOf('async getFullConversation(ctx)');
const dt      = dtStart > 0 && dtEnd > dtStart ? CR.slice(dtStart, dtEnd) : '';
assert(dt.length > 0, 'downloadTranscript body sliced');
assert(/if\s*\(\s*!ctx\.state\.user\s*\)\s*return\s+ctx\.unauthorized/.test(dt),
  'requires authenticated caller');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(dt),
  'validates id as positive integer');
assert(/chatroom\.advertiser\?\.id\s*===\s*u\.id[\s\S]{0,80}chatroom\.publisher\?\.id\s*===\s*u\.id/.test(dt),
  'party check via advertiser/publisher FK');
assert(/if\s*\(\s*!isParty\s*\)[\s\S]{0,80}ctx\.notFound/.test(dt),
  'returns 404 (not 403) on non-party');
// Populate must use field allow-lists (no full up_users leak)
const dtCode = dt.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/populate:\s*\[\s*'order'/.test(dtCode),
  'no remaining string-array populate (was returning full user objects)');
assert(/advertiser:\s*\{\s*fields:\s*\['id',\s*'username',\s*'email'\]\s*\}/.test(dtCode),
  'advertiser populate uses allow-list');
assert(/publisher:\s*\{\s*fields:\s*\['id',\s*'username',\s*'email'\]\s*\}/.test(dtCode),
  'publisher populate uses allow-list');
assert(/sender:\s*\{\s*fields:\s*\['id',\s*'username',\s*'email'\]\s*\}/.test(dtCode),
  'communications.sender populate uses allow-list');

out('\n=== 2) chatroom.getFullConversation — same hardening ===');
const fcStart = CR.indexOf('async getFullConversation(ctx)');
const fcEnd   = CR.indexOf('async adminChatView(ctx)');
const fc      = fcStart > 0 && fcEnd > fcStart ? CR.slice(fcStart, fcEnd) : '';
assert(fc.length > 0, 'getFullConversation body sliced');
assert(/if\s*\(\s*!ctx\.state\.user\s*\)\s*return\s+ctx\.unauthorized/.test(fc),
  'requires authenticated caller');
assert(/chatroom\.advertiser\?\.id\s*===\s*u\.id[\s\S]{0,80}chatroom\.publisher\?\.id\s*===\s*u\.id/.test(fc),
  'party check via advertiser/publisher FK');
assert(/if\s*\(\s*!isParty\s*\)[\s\S]{0,80}ctx\.notFound/.test(fc),
  'returns 404 (not 403) on non-party');
const fcCode = fc.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/populate:\s*\[\s*'order'/.test(fcCode),
  'no remaining string-array populate');

out('\n=== 3) chatroom.getOrCreateChatroom — populate allow-listed ===');
const gcStart = CR.indexOf('async getOrCreateChatroom(ctx)');
const gcEnd   = CR.indexOf('async getUserChatrooms(ctx)') > 0
  ? CR.indexOf('async getUserChatrooms(ctx)')
  : CR.indexOf('async markMessagesAsRead(ctx)');
const gc      = gcStart > 0 && gcEnd > gcStart ? CR.slice(gcStart, gcEnd) : '';
assert(gc.length > 0, 'getOrCreateChatroom body sliced');
// The party-check at L113-118 was already present; only the populate needed
// narrowing. Assert the final populatedChatroom uses {fields:[...]} not
// the string-array form.
assert(/populate:\s*\{[\s\S]{0,500}advertiser:\s*\{\s*fields:\s*\['id',\s*'username',\s*'email'\]\s*\}/.test(gc),
  'getOrCreateChatroom final populate uses allow-list on advertiser');

out('\n=== 4) publisher-website.admin-approval.getApprovalStatus — ownership ===');
const gasStart = AA.indexOf('async getApprovalStatus(ctx)');
const gasEnd   = AA.length;
const gas      = gasStart > 0 ? AA.slice(gasStart, gasEnd) : '';
assert(gas.length > 0, 'getApprovalStatus body sliced');
assert(/if\s*\(\s*!user\s*\)[\s\S]{0,80}ctx\.unauthorized/.test(gas),
  'requires authenticated caller');
assert(/isAdminUser\(user\)\s*\|\|\s*isOwner/.test(gas) || /!isAdminUser\(user\)\s*&&\s*!isOwner/.test(gas),
  'admin-OR-owner gate');
assert(/if\s*\(\s*!isAdminUser\(user\)\s*&&\s*!isOwner\s*\)[\s\S]{0,100}ctx\.notFound/.test(gas),
  'returns 404 on cross-tenant (enumeration defense)');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(gas),
  'validates id as positive integer');

out('\n=== 5) publisher-website.admin-approval.manualApprove — defense-in-depth admin gate ===');
const maStart = AA.indexOf('async manualApprove(ctx)');
const maEnd   = AA.indexOf('async getApprovalStatus(ctx)');
const ma      = maStart > 0 && maEnd > maStart ? AA.slice(maStart, maEnd) : '';
assert(ma.length > 0, 'manualApprove body sliced');
assert(/if\s*\(\s*!user\s*\)[\s\S]{0,80}ctx\.unauthorized/.test(ma),
  'manualApprove requires authenticated caller');
assert(/if\s*\(\s*!isAdminUser\(user\)\s*\)[\s\S]{0,80}ctx\.forbidden/.test(ma),
  'manualApprove enforces admin role at handler entry');
assert(/function\s+isAdminUser\s*\(\s*user\s*\)/.test(AA),
  'isAdminUser helper defined');
assert(/role\.type\s*===\s*'admin'\s*\|\|\s*user\.role\.type\s*===\s*'super_admin'/.test(AA),
  'isAdminUser checks admin OR super_admin role.type');
// Pre-fix echoed error.message via concatenation. Now generic.
assert(!/internalServerError\(\s*['"]Failed to approve website:?\s*['"]?\s*\+\s*error\.message/.test(AA),
  'manualApprove no longer concatenates error.message into HTTP response');

out('\n=== 6) marketplace.updateTAT — fail-CLOSED for non-admins ===');
const utStart = MP.indexOf('async updateTAT(ctx)');
const utEnd   = MP.indexOf('async getStats(ctx)') > utStart
  ? MP.indexOf('async getStats(ctx)')
  : MP.indexOf('async bulkUpdateTAT(ctx)');
const ut      = utStart > 0 && utEnd > utStart ? MP.slice(utStart, utEnd) : '';
assert(ut.length > 0, 'updateTAT body sliced');
assert(/const\s+isAdmin\s*=\s*user\.role\s*&&\s*\(\s*user\.role\.type\s*===\s*'admin'\s*\|\|\s*user\.role\.type\s*===\s*'super_admin'\s*\)/.test(ut),
  'updateTAT defines isAdmin via role.type');
assert(/if\s*\(\s*!isAdmin\s*&&\s*!isPublisher\s*\)[\s\S]{0,150}ctx\.forbidden/.test(ut),
  'updateTAT forbids advertisers (closes the prior write-IDOR)');
assert(/if\s*\(\s*!isAdmin\s*\)[\s\S]{0,800}ctx\.notFound\(\s*['"]Marketplace listing not found/.test(ut),
  'updateTAT returns 404 (not 401) on non-owner publisher');

out('\n=== 7) marketplace.getUpdateHistory — admin-OR-owner gate ===');
const ghStart = MP.indexOf('async getUpdateHistory(ctx)');
const ghEnd   = MP.length;
const gh      = ghStart > 0 ? MP.slice(ghStart, ghStart + 3000) : '';
assert(gh.length > 0, 'getUpdateHistory body sliced');
assert(/if\s*\(\s*!user\s*\)\s*return\s+ctx\.unauthorized/.test(gh),
  'getUpdateHistory requires authenticated caller');
assert(/const\s+isAdmin\s*=\s*user\.role\s*&&\s*\(\s*user\.role\.type\s*===\s*'admin'\s*\|\|\s*user\.role\.type\s*===\s*'super_admin'\s*\)/.test(gh),
  'getUpdateHistory defines isAdmin via role.type');
assert(/if\s*\(\s*!isAdmin\s*\)[\s\S]{0,800}ctx\.notFound\(\s*['"]Marketplace listing not found/.test(gh),
  'getUpdateHistory returns 404 on non-admin non-owner');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
