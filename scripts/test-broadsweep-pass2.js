#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 2.
 *
 * Closes CRITICAL Authenticated-role default-router IDORs on:
 *   - withdrawal-request: GET /api/withdrawal-requests[/:id], PUT, DELETE
 *   - chatroom:           GET /api/chatrooms[/:id], PUT
 *   - outsourced-content: GET /api/outsourced-contents[/:id], PUT, DELETE
 *
 * All three content types have createCoreRouter exposed routes + Authenticated
 * role permissions but had NO controller overrides. Any logged-in user could
 * cross-tenant list/read/update/delete every row platform-wide. For
 * withdrawal-request that meant payout-destination JSON leakage and admin_notes
 * mutation; for chatroom that meant cross-conversation reads + reassign;
 * for outsourced-content that meant content + instructions read/write IDOR.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass2.js
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

const WR = read('src/api/withdrawal-request/controllers/withdrawal-request.js');
const CR = read('src/api/chatroom/controllers/chatroom.js');
const OC = read('src/api/outsourced-content/controllers/outsourced-content.js');

out('\n=== 1) withdrawal-request — find/findOne/update/delete overrides ===');
assert(/async\s+find\s*\(\s*ctx\s*\)/.test(WR), 'find() overridden');
assert(/async\s+findOne\s*\(\s*ctx\s*\)/.test(WR), 'findOne() overridden');
assert(/async\s+update\s*\(\s*ctx\s*\)[\s\S]{0,800}ctx\.forbidden/.test(WR), 'update() overridden to 403');
assert(/async\s+delete\s*\(\s*ctx\s*\)[\s\S]{0,300}ctx\.forbidden/.test(WR), 'delete() overridden to 403');
assert(/function\s+isAdminUser\s*\(/.test(WR), 'isAdminUser helper');
assert(/function\s+isWithdrawalOwner\s*\(/.test(WR), 'isWithdrawalOwner helper');
assert(/role\s*&&\s*user\.role\.type\s*===\s*'admin'/.test(WR),
  'admin gate uses role.type === "admin" (no magic-string backdoor)');
assert(/WITHDRAWAL_USER_FIELDS/.test(WR),
  'WITHDRAWAL_USER_FIELDS allow-list defined');
const wrFieldsMatch = WR.match(/const\s+WITHDRAWAL_USER_FIELDS\s*=\s*\[([^\]]+)\]/);
const wrFields = wrFieldsMatch ? wrFieldsMatch[1] : '';
// `details` (bank/PayPal destination) MUST NOT be in the listing allow-list.
// Strip JS-comment lines so the inline comment explaining why we OMIT
// details doesn't false-positive.
const wrFieldsCode = wrFields.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/['"]details['"]/.test(wrFieldsCode),
  'details JSON (bank/PayPal data) NOT in listing allow-list');
// admin_notes MUST NOT be exposed
assert(!/['"]admin_notes['"]/.test(wrFields) && !/['"]adminNotes['"]/.test(wrFields),
  'admin_notes NOT in user-facing allow-list');
// Owner's findOne MAY return details (their own data)
assert(/isWithdrawalOwner\(record,\s*ctx\.state\.user\)[\s\S]{0,200}safe\.details\s*=\s*record\.details/.test(WR),
  'findOne surfaces details ONLY to the owner');

out('\n=== 2) chatroom — find/findOne/update overrides ===');
assert(/async\s+find\s*\(\s*ctx\s*\)/.test(CR), 'find() overridden');
assert(/async\s+findOne\s*\(\s*ctx\s*\)/.test(CR), 'findOne() overridden');
assert(/async\s+update\s*\(\s*ctx\s*\)[\s\S]{0,400}ctx\.forbidden/.test(CR), 'update() overridden to 403');
assert(/function\s+buildChatroomOwnership\s*\(/.test(CR), 'buildChatroomOwnership helper');
assert(/\{\s*advertiser:\s*user\.id\s*\}/.test(CR) && /\{\s*publisher:\s*user\.id\s*\}/.test(CR),
  'ownership filter includes advertiser FK + publisher FK');
assert(/CHATROOM_USER_FIELDS\s*=\s*\['id',\s*'username'\]/.test(CR),
  'CHATROOM_USER_FIELDS = [id, username] (no PII leak via populate)');
const crFindOneStart = CR.indexOf('async findOne(ctx)');
const crFindOneEnd   = CR.indexOf('async update(ctx)', crFindOneStart);
const crFindOne = crFindOneStart > 0 && crFindOneEnd > crFindOneStart ? CR.slice(crFindOneStart, crFindOneEnd) : '';
assert(/if\s*\(\s*!isParty\s*\)[\s\S]{0,80}ctx\.notFound/.test(crFindOne),
  'findOne returns 404 (not 403) on non-party');

out('\n=== 3) outsourced-content — find/findOne/update/delete overrides ===');
assert(/async\s+find\s*\(\s*ctx\s*\)/.test(OC), 'find() overridden');
assert(/async\s+findOne\s*\(\s*ctx\s*\)/.test(OC), 'findOne() overridden');
assert(/async\s+update\s*\(\s*ctx\s*\)/.test(OC), 'update() overridden');
assert(/async\s+delete\s*\(\s*ctx\s*\)[\s\S]{0,200}ctx\.forbidden/.test(OC), 'delete() overridden to 403');
assert(/function\s+findOrderForOutsourced\s*\(/.test(OC), 'findOrderForOutsourced helper');
assert(/function\s+isPartyToOrder\s*\(/.test(OC), 'isPartyToOrder helper');
assert(/OUTSOURCED_PUBLIC_FIELDS/.test(OC), 'OUTSOURCED_PUBLIC_FIELDS allow-list defined');
// find uses the order.advertiser / publisher / snapshot-email scope
assert(/\{\s*order:\s*\{\s*advertiser:\s*u\.id\s*\}\s*\}/.test(OC),
  'find filter scoped via order.advertiser');
assert(/\{\s*order:\s*\{\s*publisher:\s*u\.id\s*\}\s*\}/.test(OC),
  'find filter scoped via order.publisher');
// update is advertiser-only (only the buyer can edit their own outsourced spec)
const ocUpdate = (OC.match(/async\s+update\s*\(\s*ctx\s*\)\s*\{[\s\S]+?\n  \},\n/) || [''])[0];
assert(/order\?\.advertiser\?\.id\s*!==\s*ctx\.state\.user\.id/.test(ocUpdate),
  'update restricted to order advertiser');
assert(/if\s*\(\s*existing\.order\?\.advertiser\?\.id\s*!==\s*ctx\.state\.user\.id\s*\)[\s\S]{0,200}ctx\.notFound/.test(ocUpdate),
  'update returns 404 (not 403) on non-advertiser');
// Field whitelist on update — no sender/order reassignment
assert(!/allowed\.order\s*=/.test(ocUpdate),
  'update never lets caller reassign the order FK');

out('\n=== 4) None of the three echoes error.message ===');
// withdrawal-request: existing controller has many endpoints with error.message
// echoes. We only assert the NEW overrides (find/findOne/update/delete) don't
// echo. (The full file still has older paths that we'll address in a later pass.)
const wrFind = (WR.match(/async\s+find\s*\(\s*ctx\s*\)\s*\{[\s\S]+?\n  \},\n/) || [''])[0];
const wrFindOne = (WR.match(/async\s+findOne\s*\(\s*ctx\s*\)\s*\{[\s\S]+?\n  \},\n/) || [''])[0];
const wrUpdate = (WR.match(/async\s+update\s*\(\s*ctx\s*\)\s*\{[\s\S]+?\n  \},\n/) || [''])[0];
for (const [name, body] of [['wr.find', wrFind], ['wr.findOne', wrFindOne], ['wr.update', wrUpdate]]) {
  assert(!/error\.message/.test(body), `${name} does not reference error.message`);
}

out('\n=== 5) Default-route smoke: anonymous probes return 403 ===');
// We can't curl from inside a static test, but the route declarations
// + the in-handler !user check both ensure anonymous → 401/403.
const expectedUnauth = /if\s*\(\s*!ctx\.state\.user\s*\)[\s\S]{0,100}ctx\.unauthorized/;
assert(expectedUnauth.test(WR), 'withdrawal-request override gates unauthenticated');
assert(expectedUnauth.test(CR), 'chatroom override gates unauthenticated');
assert(expectedUnauth.test(OC), 'outsourced-content override gates unauthenticated');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
