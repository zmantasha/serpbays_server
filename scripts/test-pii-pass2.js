#!/usr/bin/env node
/**
 * Regression test — PII pass 2 (chat-system response sanitization).
 *
 * Static-grep checks that the user-facing chatroom/communication
 * endpoints never leak email, username, documentId, or other PII to
 * the counter-party.
 *
 * Run: cd serpbays_server && node scripts/test-pii-pass2.js
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

const CHAT = read('src/api/chatroom/controllers/chatroom.js');
const COMM = read('src/api/communication/controllers/communication.js');
const NOTIF = read('src/api/notification/controllers/notification.js');
const CLIENT_IFACE = read('/var/www/serpbays/serpbays_client/lib/services/communicationService.ts');

// Helper: extract the body of a named handler so we don't false-positive
// on a totally different handler's content. Match from `async name(` to
// the next `async name2(` or end of file.
function handler(src, name) {
  const re = new RegExp(`async ${name}\\(ctx\\)[\\s\\S]*?(?=async [a-zA-Z]+\\(ctx\\)|module\\.exports|$)`);
  const m = src.match(re);
  return m ? m[0] : '';
}

out('\n=== A. /api/chatrooms/user/conversations (the reported leak) ===');

// A1. The populate is allow-listed (not string-form)
{
  const fn = handler(CHAT, 'getUserChatrooms');
  assert(/fields:\s*CHATROOM_USER_FIELDS/.test(fn),
    'getUserChatrooms populate uses CHATROOM_USER_FIELDS for advertiser/publisher/sender');
  assert(!/populate:\s*\[\s*['"]order['"]/.test(fn),
    'getUserChatrooms has no string-form populate (would auto-include full users)');
}

// A2. Constructed response uses sanitizeUserRef (not literal {id,username,email})
{
  const fn = handler(CHAT, 'getUserChatrooms');
  assert(/otherParty:\s*sanitizeUserRef\(/.test(fn),
    'getUserChatrooms otherParty goes through sanitizeUserRef');
  assert(/sender:\s*sanitizeUserRef\(/.test(fn),
    'getUserChatrooms latestMessage.sender goes through sanitizeUserRef');
  assert(!/email:\s*otherParty\?\.email|email:\s*latestMessage/.test(fn),
    'getUserChatrooms response no longer hardcodes email');
  assert(!/username:\s*otherParty\?\.username|username:\s*latestMessage/.test(fn),
    'getUserChatrooms response no longer hardcodes username');
}

out('\n=== B. CHATROOM_USER_FIELDS + sanitizer correctness ===');

// B1. CHATROOM_USER_FIELDS is exactly ['id'] (strictest PoLP)
{
  const m = CHAT.match(/const CHATROOM_USER_FIELDS\s*=\s*\[([^\]]*)\]/);
  assert(m && /^\s*['"]id['"]\s*$/.test(m[1]),
    'CHATROOM_USER_FIELDS = ["id"] (no username/email)');
}

// B2. CHATROOM_PUBLIC_FIELDS excludes documentId
{
  const m = CHAT.match(/const CHATROOM_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  assert(m && !/documentId/.test(m[1]),
    'CHATROOM_PUBLIC_FIELDS excludes documentId');
}

// B3. sanitizeUserRef returns { id } only
{
  const m = CHAT.match(/function sanitizeUserRef[\s\S]*?\n\}/);
  assert(m && /return\s*\{\s*id:\s*u\.id\s*\}/.test(m[0]),
    'sanitizeUserRef returns { id } only');
}

out('\n=== C. Other chatroom endpoints — getOrCreate / getFullConversation / downloadTranscript ===');

// C1. NO chatroom populate site retains `fields: ['id','username','email']`
assert(!/fields:\s*\[\s*['"]id['"]\s*,\s*['"]username['"]\s*,\s*['"]email['"]/.test(CHAT),
  'no chatroom populate retains the [id,username,email] allow-list');

// C2. getFullConversation no longer constructs participants/sender with username+email
{
  const fn = handler(CHAT, 'getFullConversation');
  assert(!/username:\s*chatroom\.(advertiser|publisher)\?\./.test(fn),
    'getFullConversation participants no longer hardcode username');
  assert(!/email:\s*chatroom\.(advertiser|publisher)\?\./.test(fn),
    'getFullConversation participants no longer hardcode email');
  assert(!/username:\s*comm\.sender\?\.|email:\s*comm\.sender\?\./.test(fn),
    'getFullConversation message.sender no longer hardcodes username/email');
}

out('\n=== D. /api/communications — populate + shapeForResponse ===');

// D1. SENDER_PUBLIC_FIELDS is just ['id']
{
  const m = COMM.match(/const SENDER_PUBLIC_FIELDS\s*=\s*\[([^\]]*)\]/);
  assert(m && /^\s*['"]id['"]\s*$/.test(m[1]),
    'communication SENDER_PUBLIC_FIELDS = ["id"]');
}

// D2. COMM_PUBLIC_FIELDS excludes documentId
{
  const m = COMM.match(/const COMM_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  assert(m && !/documentId/.test(m[1]),
    'COMM_PUBLIC_FIELDS excludes documentId');
}

// D3. ORDER_PUBLIC_FIELDS_FOR_COMM excludes documentId
{
  const m = COMM.match(/const ORDER_PUBLIC_FIELDS_FOR_COMM\s*=\s*\[([\s\S]*?)\]/);
  assert(m && !/documentId/.test(m[1]),
    'ORDER_PUBLIC_FIELDS_FOR_COMM excludes documentId');
}

// D4. communication.findOne no longer uses sender: true
{
  const fn = handler(COMM, 'findOne');
  assert(/sender:\s*\{\s*select:\s*SENDER_PUBLIC_FIELDS\s*\}/.test(fn),
    'communication.findOne populate.sender is allow-listed (not sender: true)');
}

// D5. No inline `sender: { id: ..., username: ... }` literal anywhere
assert(!/sender:\s*\{\s*id:\s*user\.id\s*,\s*username:\s*user\.username\s*\}/.test(COMM),
  'communication.js has no inline { id, username } sender literal');

out('\n=== E. /api/notifications — pre-existing safety, re-verify ===');

// E1. notifications populate uses { select: ['id'] } for recipient
{
  assert(/populate:\s*\{\s*recipient:\s*\{\s*select:\s*\[\s*['"]id['"]\s*\]\s*\}/.test(NOTIF),
    'notification controller uses populate.recipient = select:[id]');
}

out('\n=== F. Client TypeScript interface — drop dead fields ===');

// F1. Conversation interface no longer types username/email on otherParty/sender
{
  const conv = CLIENT_IFACE.match(/export interface Conversation[\s\S]*?\n\}/);
  const body = conv ? conv[0] : '';
  assert(!/otherParty:\s*\{[^}]*username/.test(body),
    'client Conversation.otherParty no longer declares username');
  assert(!/otherParty:\s*\{[^}]*email/.test(body),
    'client Conversation.otherParty no longer declares email');
  assert(!/sender:\s*\{[^}]*username|sender:\s*\{[^}]*email/.test(body),
    'client Conversation.latestMessage.sender no longer declares username/email');
}

out('\n=== G. Audit — no broad user populates in user-facing chat paths ===');

// G1. No bare `populate: ['advertiser', 'publisher']` in user-facing chatroom handlers
// (admin paths are allowed)
{
  // Sample the 4 known user-facing handlers
  for (const fn of ['getUserChatrooms', 'getOrCreateChatroom', 'getFullConversation', 'updateStatus']) {
    const body = handler(CHAT, fn);
    const hasBareUserPop = /populate:\s*\[[^\]]*['"](advertiser|publisher|sender)['"]/.test(body);
    assert(!hasBareUserPop,
      `${fn} has no string-form populate of advertiser/publisher/sender`);
  }
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
