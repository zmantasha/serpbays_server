#!/usr/bin/env node
/**
 * Regression test: communication endpoints — authz + IDOR hardening.
 *
 * Findings remediated by this commit:
 *   - HIGH: Default `find` / `findOne` / `update` (Authenticated role had
 *     permission) returned every message on the platform with no
 *     ownership filter. Now overridden.
 *   - CRITICAL: Every response that populated `sender` returned the FULL
 *     up_users row (password hash, withdrawalOtp + amount, paypal /
 *     payoneer emails, billing PII, clerk_id, tokenVersion). Same class
 *     as the project audit. Fixed by allow-list { id, username }.
 *   - CRITICAL: Dead handlers `acceptOrder` / `requestRevision` /
 *     `startRevision` / `completeRevision` / `getUserConversations`
 *     existed without auth or IDOR checks. acceptOrder marked any order
 *     completed (wallet release trigger). Removed.
 *   - MEDIUM: Inputs unvalidated (no message length cap, no integer
 *     check on order id, no enum check on status). Added.
 *   - LOW: Snapshot-publisher fallback for legacy orders.
 *
 * Static-grep test — no Strapi load.
 *
 * Run: cd serpbays_server && node scripts/test-communications-authz.js
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

const CTRL = read('src/api/communication/controllers/communication.js');

out('\n=== 1) Allow-list constants defined ===');
assert(/const\s+SENDER_PUBLIC_FIELDS\s*=\s*\[/.test(CTRL), 'SENDER_PUBLIC_FIELDS defined');
assert(/const\s+ORDER_PUBLIC_FIELDS_FOR_COMM\s*=\s*\[/.test(CTRL), 'ORDER_PUBLIC_FIELDS_FOR_COMM defined');
assert(/const\s+COMM_PUBLIC_FIELDS\s*=\s*\[/.test(CTRL), 'COMM_PUBLIC_FIELDS defined');
const senderMatch = CTRL.match(/const\s+SENDER_PUBLIC_FIELDS\s*=\s*\[([^\]]+)\]/);
const senderFields = senderMatch ? senderMatch[1] : '';
const FORBIDDEN_SENDER_FIELDS = [
  'password', 'resetPasswordToken', 'confirmationToken',
  'withdrawalOtp', 'withdrawalOtpExpiry', 'withdrawalOtpAmount', 'withdrawalOtpAttempts',
  'paypal_email', 'paypalEmail', 'payoneer_email', 'payoneerEmail',
  'billing_address', 'phone_number', 'vat_gst_number', 'clerk_id', 'token_version',
];
for (const banned of FORBIDDEN_SENDER_FIELDS) {
  assert(!new RegExp(`['"]${banned}['"]`).test(senderFields),
    `sender allow-list excludes '${banned}'`);
}

out('\n=== 2) isPartyToOrder helper with snapshot-publisher fallback ===');
assert(/function\s+isPartyToOrder\s*\(/.test(CTRL),
  'isPartyToOrder helper defined');
assert(/order\.advertiser\s*&&\s*order\.advertiser\.id\s*===\s*user\.id/.test(CTRL),
  'advertiser FK check');
assert(/order\.publisher\s*&&\s*order\.publisher\.id\s*===\s*user\.id/.test(CTRL),
  'publisher FK check');
assert(/!order\.publisher\?\.id[\s\S]{0,200}order\.websitePublisherEmail\s*===\s*user\.email/.test(CTRL),
  'snapshot-email fallback gated on missing publisher FK');

out('\n=== 3) Default `find` override with ownership filter ===');
const findStart = CTRL.indexOf('async find(ctx)');
const findEnd   = CTRL.indexOf('async findOne(ctx)');
const findBody  = findStart > 0 && findEnd > findStart ? CTRL.slice(findStart, findEnd) : '';
assert(findBody.length > 0, 'find body sliced');
assert(/if\s*\(\s*!ctx\.state\.user\s*\)[\s\S]{0,80}ctx\.unauthorized/.test(findBody),
  'find rejects unauthenticated');
assert(/buildCommOwnershipFilter\s*\(\s*ctx\.state\.user\s*\)/.test(findBody),
  'find uses ownership filter');
assert(/userFilters\s*\?\s*\{\s*\$and:\s*\[\s*userFilters\s*,\s*ownership\s*\]/.test(findBody),
  'find merges caller filters under $and (cannot widen scope)');
assert(/fields:\s*COMM_PUBLIC_FIELDS/.test(findBody),
  'find forces field allow-list');
assert(/sender:\s*\{\s*fields:\s*SENDER_PUBLIC_FIELDS/.test(findBody),
  'find populate uses SENDER_PUBLIC_FIELDS allow-list');

out('\n=== 4) `findOne` override with ownership check ===');
const findOneStart = CTRL.indexOf('async findOne(ctx)');
const findOneEnd   = CTRL.indexOf('async update(ctx)');
const findOneBody  = findOneStart > 0 && findOneEnd > findOneStart ? CTRL.slice(findOneStart, findOneEnd) : '';
assert(findOneBody.length > 0, 'findOne body sliced');
assert(/if\s*\(\s*!ctx\.state\.user\s*\)[\s\S]{0,80}ctx\.unauthorized/.test(findOneBody),
  'findOne rejects unauthenticated');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(findOneBody),
  'findOne validates id as positive integer');
assert(/isSenderSelf[\s\S]{0,80}isParty/.test(findOneBody),
  'findOne accepts sender-self OR order-party');
assert(/if\s*\(\s*!isSenderSelf\s*&&\s*!isParty\s*\)[\s\S]{0,80}ctx\.notFound/.test(findOneBody),
  'findOne returns 404 (not 403) on no-access');
assert(!/ctx\.forbidden\(/.test(findOneBody),
  'findOne never returns 403');

out('\n=== 5) `update` override — sender-only, field-whitelisted ===');
const updateStart = CTRL.indexOf('async update(ctx)');
const updateEnd   = CTRL.indexOf('async delete(ctx)');
const updateBody  = updateStart > 0 && updateEnd > updateStart ? CTRL.slice(updateStart, updateEnd) : '';
assert(updateBody.length > 0, 'update body sliced');
assert(/existing\.sender\?\.id\s*!==\s*ctx\.state\.user\.id/.test(updateBody),
  'update restricts to original sender');
assert(/if\s*\(\s*existing\.sender\?\.id\s*!==\s*ctx\.state\.user\.id\s*\)[\s\S]{0,400}ctx\.notFound/.test(updateBody),
  'update returns 404 (not 403) on non-sender');
// Field whitelist
assert(/typeof\s+body\.message\s*===\s*'string'/.test(updateBody),
  'update validates message type');
assert(/VALID_STATUS\.includes\s*\(\s*body\.communicationStatus\s*\)/.test(updateBody),
  'update validates communicationStatus enum');
// Sender / order / chatroom never overwritten by the body
assert(!/allowed\.sender\s*=/.test(updateBody) && !/allowed\.order\s*=/.test(updateBody) && !/allowed\.chatroom\s*=/.test(updateBody),
  'update never lets caller reassign sender/order/chatroom');

out('\n=== 6) `delete` override — disabled ===');
const deleteStart = CTRL.indexOf('async delete(ctx)');
const deleteEnd   = CTRL.indexOf('// ===== Custom handlers');
const deleteBody  = deleteStart > 0 && deleteEnd > deleteStart ? CTRL.slice(deleteStart, deleteEnd) : '';
assert(deleteBody.length > 0, 'delete body sliced');
assert(/ctx\.forbidden\(\s*'Communications cannot be deleted'/.test(deleteBody),
  'delete is forbidden outright (append-only audit trail)');

out('\n=== 7) `create` — input validation + sender forced + party check ===');
const createStart = CTRL.indexOf('async create(ctx)');
const createEnd   = CTRL.indexOf('async getOrderCommunications(ctx)');
const createBody  = createStart > 0 && createEnd > createStart ? CTRL.slice(createStart, createEnd) : '';
assert(createBody.length > 0, 'create body sliced');
assert(/typeof\s+data\.message\s*!==\s*'string'/.test(createBody),
  'create rejects non-string message');
assert(/message\.length\s*===\s*0\s*\|\|\s*message\.length\s*>\s*MAX_MESSAGE_LENGTH/.test(createBody),
  'create enforces message length 1..MAX_MESSAGE_LENGTH');
assert(/Number\.isInteger\s*\(\s*orderId\s*\)/.test(createBody),
  'create validates order id as positive integer');
assert(/VALID_STATUS\.includes\s*\(\s*communicationStatus\s*\)/.test(createBody),
  'create validates communicationStatus enum');
assert(/isPartyToOrder\s*\(\s*order\s*,\s*user\s*\)/.test(createBody),
  'create requires the caller to be a party to the order');
assert(/!isPartyToOrder\(order,\s*user\)[\s\S]{0,300}ctx\.notFound/.test(createBody),
  'create returns 404 (not 403) on cross-tenant create');
assert(/sender:\s*user\.id/.test(createBody),
  'create forces sender = ctx.state.user.id (caller cannot impersonate)');
assert(/sender:\s*\{\s*fields:\s*SENDER_PUBLIC_FIELDS/.test(createBody),
  'create response populates sender with allow-list');
assert(/shapeForResponse\s*\(\s*populated\s*\)/.test(createBody),
  'create response is shaped before returning');

out('\n=== 8) `getOrderCommunications` — party check + allow-list ===');
const goeStart = CTRL.indexOf('async getOrderCommunications(ctx)');
const goeEnd   = CTRL.indexOf('async updateStatus(ctx)');
const goeBody  = goeStart > 0 && goeEnd > goeStart ? CTRL.slice(goeStart, goeEnd) : '';
assert(goeBody.length > 0, 'getOrderCommunications body sliced');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(goeBody),
  'getOrderCommunications validates orderId as positive integer');
assert(/if\s*\(\s*!order\s*\|\|\s*!isPartyToOrder\(order,\s*user\)\s*\)[\s\S]{0,80}ctx\.notFound/.test(goeBody),
  'getOrderCommunications returns 404 on cross-tenant');
assert(/fields:\s*COMM_PUBLIC_FIELDS/.test(goeBody),
  'getOrderCommunications uses comm field allow-list');
assert(/sender:\s*\{\s*fields:\s*SENDER_PUBLIC_FIELDS/.test(goeBody),
  'getOrderCommunications uses sender allow-list');

out('\n=== 9) `updateStatus` — party check + allow-list + input validation ===');
const usStart = CTRL.indexOf('async updateStatus(ctx)');
const usEnd   = CTRL.length;
const usBody  = usStart > 0 ? CTRL.slice(usStart, usEnd) : '';
assert(usBody.length > 0, 'updateStatus body sliced');
assert(/Number\.isInteger\s*\(\s*numericId\s*\)/.test(usBody),
  'updateStatus validates id as positive integer');
assert(/VALID_STATUS\.includes\s*\(\s*communicationStatus\s*\)/.test(usBody),
  'updateStatus validates status enum BEFORE DB read (cheap reject)');
assert(/isPartyToOrder\s*\(\s*existing\.order\s*,\s*user\s*\)/.test(usBody),
  'updateStatus checks party via existing.order populate');
assert(/sender:\s*\{\s*fields:\s*SENDER_PUBLIC_FIELDS/.test(usBody),
  'updateStatus response populates sender with allow-list');

out('\n=== 10) Dead handlers removed — no auth-less order-completion / revision primitives ===');
for (const ghost of ['acceptOrder', 'requestRevision', 'startRevision', 'completeRevision', 'getUserConversations']) {
  assert(!new RegExp(`async\\s+${ghost}\\s*\\(`).test(CTRL),
    `handler '${ghost}' removed (was unauth + IDOR-able if ever routed)`);
}

out('\n=== 11) Error responses never echo error.message ===');
assert(!/internalServerError\([^)]*error\.message/.test(CTRL),
  'no internalServerError(..., error.message)');
assert(!/badRequest\([^)]*error\.message/.test(CTRL),
  'no badRequest(..., error.message)');

out('\n=== 12) Frontend contract — surfaces still respond { data: ... } ===');
// The TS client expects { data } shape on getOrderCommunications + create + updateStatus.
const dataReturns = (CTRL.match(/return\s*\{\s*data:/g) || []).length;
assert(dataReturns >= 3, `at least 3 { data: ... } returns in the file (found ${dataReturns})`);

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
