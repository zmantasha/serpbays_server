#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 3.
 *
 * Closes the partial-coverage gaps:
 *   - saved-filter: findOne + update missing (IDOR read/write); find populate
 *     leaked full users_permissions_user row.
 *   - shortlist: findOne + update missing (IDOR read/write).
 *   - website-request: find/findOne fail-OPEN for non-advertiser non-admin
 *     callers (no scope applied to publishers / plain users) → cross-tenant
 *     list; update missing (write IDOR).
 *   - notification: getMyNotifications populated 'recipient' → full
 *     up_users row leak; limit uncapped (DoS); JSON-dump of all
 *     notifications to server logs (PII).
 *   - notification: markAsRead / deleteNotification returned 403 on
 *     non-owner (enumeration vector).
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass3.js
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

const SF = read('src/api/saved-filter/controllers/saved-filter.js');
const SL = read('src/api/shortlist/controllers/shortlist.js');
const WR = read('src/api/website-request/controllers/website-request.js');
const NT = read('src/api/notification/controllers/notification.js');

out('\n=== 1) saved-filter — findOne / update added; populate leak fixed ===');
assert(/async\s+findOne\s*\(\s*ctx\s*\)/.test(SF), 'findOne overridden');
assert(/async\s+update\s*\(\s*ctx\s*\)/.test(SF), 'update overridden');
// find no longer populates the user
const sfFindStart = SF.indexOf('async find(ctx)');
const sfFindEnd = SF.indexOf('async findOne(ctx)');
const sfFind = sfFindStart > 0 && sfFindEnd > sfFindStart ? SF.slice(sfFindStart, sfFindEnd) : '';
assert(!/populate:\s*\[/.test(sfFind),
  'saved-filter.find no longer uses string-array populate (users_permissions_user removed)');
assert(/fields:\s*\['id',\s*'documentId',\s*'name',\s*'filterConfig'/.test(sfFind),
  'saved-filter.find uses explicit fields allow-list');
// findOne — 404 on cross-tenant
const sfFindOneStart = SF.indexOf('async findOne(ctx)');
const sfFindOneEnd   = SF.indexOf('async update(ctx)', sfFindOneStart);
const sfFindOne      = sfFindOneStart > 0 && sfFindOneEnd > sfFindOneStart ? SF.slice(sfFindOneStart, sfFindOneEnd) : '';
assert(/record\.users_permissions_user\?\.id\s*!==\s*user\.id[\s\S]{0,80}ctx\.notFound/.test(sfFindOne),
  'findOne returns 404 (not 403) on cross-tenant');
// update — sender-only field allow-list
const sfUpdateStart = SF.indexOf('async update(ctx)');
const sfUpdateEnd   = SF.indexOf('async delete(ctx)', sfUpdateStart);
const sfUpdate      = sfUpdateStart > 0 && sfUpdateEnd > sfUpdateStart ? SF.slice(sfUpdateStart, sfUpdateEnd) : '';
assert(/existing\.users_permissions_user\?\.id\s*!==\s*user\.id[\s\S]{0,80}ctx\.notFound/.test(sfUpdate),
  'update returns 404 (not 403) on cross-tenant');
assert(/allowed\.name\s*=/.test(sfUpdate) && /allowed\.filterConfig\s*=/.test(sfUpdate),
  'update field allow-list = { name, filterConfig } only');
assert(!/allowed\.users_permissions_user\s*=/.test(sfUpdate),
  'update never lets caller reassign users_permissions_user');
// delete no longer leaks err.message
assert(!/badRequest\([^)]*err\.message/.test(SF),
  'no err.message echoed in saved-filter responses');

out('\n=== 2) shortlist — findOne + update gating ===');
assert(/async\s+findOne\s*\(\s*ctx\s*\)/.test(SL), 'findOne overridden');
const slFindOneStart = SL.indexOf('async findOne(ctx)');
const slFindOneEnd   = SL.indexOf('async update(ctx)', slFindOneStart);
const slFindOne      = slFindOneStart > 0 && slFindOneEnd > slFindOneStart ? SL.slice(slFindOneStart, slFindOneEnd) : '';
assert(/record\.owner\?\.id\s*!==\s*user\.id/.test(slFindOne) || /!record\s*\|\|\s*record\.owner\?\.id\s*!==\s*user\.id/.test(slFindOne),
  'findOne checks owner ownership');
assert(/ctx\.notFound\('Shortlist item not found'\)/.test(slFindOne),
  'findOne returns 404 on cross-tenant');
const slUpdateStart = SL.indexOf('async update(ctx)');
const slUpdateEnd   = SL.indexOf('async find(ctx)', slUpdateStart);
const slUpdate      = slUpdateStart > 0 && slUpdateEnd > slUpdateStart ? SL.slice(slUpdateStart, slUpdateEnd) : '';
assert(/ctx\.forbidden/.test(slUpdate),
  'update overridden to forbid (delete + re-add is the supported flow)');

out('\n=== 3) website-request — fail-CLOSED for non-admin non-advertiser ===');
const wrFindStart = WR.indexOf('async find(ctx)');
const wrFindEnd   = WR.indexOf('async findOne(ctx)', wrFindStart);
const wrFind      = wrFindStart > 0 && wrFindEnd > wrFindStart ? WR.slice(wrFindStart, wrFindEnd) : '';
assert(/user\.role\s*&&\s*user\.role\.type\s*===\s*'admin'/.test(wrFind),
  'find checks role.type === "admin" for unscoped access');
assert(/userFilter\s*=\s*\{\s*userEmail:\s*user\.email\s*\}/.test(wrFind),
  'non-admin callers filtered to userEmail (fail-CLOSED)');
assert(/ctx\.query\.filters\s*\?\s*\{\s*\$and:\s*\[\s*ctx\.query\.filters\s*,\s*userFilter\s*\]/.test(wrFind),
  'find merges existing filters under $and (cannot widen scope)');
const wrFindOneStart = WR.indexOf('async findOne(ctx)');
const wrFindOneEnd   = WR.indexOf('async update(ctx)', wrFindOneStart);
const wrFindOne      = wrFindOneStart > 0 && wrFindOneEnd > wrFindOneStart ? WR.slice(wrFindOneStart, wrFindOneEnd) : '';
assert(/!isAdmin\s*&&\s*entity\.userEmail\s*!==\s*user\.email[\s\S]{0,80}ctx\.notFound/.test(wrFindOne),
  'findOne returns 404 (not 403) on cross-tenant');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(wrFindOne),
  'findOne validates id as positive integer');
assert(/async\s+update\s*\(\s*ctx\s*\)[\s\S]{0,200}ctx\.forbidden/.test(WR),
  'website-request.update forbidden');
assert(/async\s+delete\s*\(\s*ctx\s*\)[\s\S]{0,200}ctx\.forbidden/.test(WR),
  'website-request.delete forbidden');

out('\n=== 4) notification — recipient populate leak fixed + 404 enumeration defense ===');
const nGmnStart = NT.indexOf('async getMyNotifications(ctx)');
const nGmnEnd   = NT.indexOf('async markAsRead(ctx)');
const nGmn      = nGmnStart > 0 && nGmnEnd > nGmnStart ? NT.slice(nGmnStart, nGmnEnd) : '';
assert(nGmn.length > 0, 'getMyNotifications body sliced');
assert(!/populate:\s*\['recipient'\]/.test(nGmn),
  "getMyNotifications no longer populates 'recipient' (closed full up_users leak)");
assert(/Math\.min\s*\(\s*rawLimit\s*,\s*100\s*\)/.test(nGmn),
  'limit hard-capped at 100');
assert(!/console\.log\([\s\S]{0,200}JSON\.stringify\(notifications/.test(nGmn),
  'no full-notification JSON dump in server logs');
// markAsRead — 404 enumeration defense
const nMarStart = NT.indexOf('async markAsRead(ctx)');
const nMarEnd   = NT.indexOf('async markAllAsRead(ctx)');
const nMar      = nMarStart > 0 && nMarEnd > nMarStart ? NT.slice(nMarStart, nMarEnd) : '';
assert(!/ctx\.forbidden\(/.test(nMar),
  'markAsRead never returns 403 (only 404 on cross-tenant)');
assert(/notification\.recipient\?\.id\s*!==\s*userId[\s\S]{0,80}ctx\.notFound/.test(nMar),
  'markAsRead returns 404 on non-recipient');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(nMar),
  'markAsRead validates id');
// deleteNotification — same enumeration defense
const nDelStart = NT.indexOf('async deleteNotification(ctx)');
const nDelEnd   = NT.length;
const nDel      = nDelStart > 0 ? NT.slice(nDelStart, nDelEnd) : '';
assert(/notification\.recipient\?\.id\s*!==\s*userId[\s\S]{0,80}ctx\.notFound/.test(nDel),
  'deleteNotification returns 404 on non-recipient');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(nDel),
  'deleteNotification validates id');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
