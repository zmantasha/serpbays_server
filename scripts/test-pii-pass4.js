#!/usr/bin/env node
/**
 * Regression test — PII pass 4 (cart endpoints).
 *
 * Static-grep checks that /api/cart never returns the populated `user`
 * relation in any of its three handlers. The pre-fix code did
 * `populate: ['user']` + `return { ...cart }` which leaked the full
 * up_users row — password (null), resetPasswordToken, confirmationToken,
 * clerkId, email, username, provider, confirmed, blocked.
 *
 * Run: cd serpbays_server && node scripts/test-pii-pass4.js
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
// Strip JS comments so allow-list extraction doesn't false-positive on
// commented-out strings.
const stripJsComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const CART = read('src/api/cart/controllers/cart.js');
const CART_NO_COMMENTS = stripJsComments(CART);

out('\n=== A. /api/cart leak surfaces are closed ===');

// A1. No populate of user/users in real code (comments excluded)
assert(!/populate:\s*\[[^\]]*['"]user['"]/.test(CART_NO_COMMENTS),
  'no string-form populate of "user" in cart controller');
assert(!/populate:\s*\{[\s\S]{0,200}user:\s*(true|\{)/.test(CART_NO_COMMENTS),
  'no object-form populate of user (user: true | user: {...})');

// A2. CART_PUBLIC_FIELDS exists and excludes the user relation
{
  const m = CART.match(/const CART_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  assert(m, 'CART_PUBLIC_FIELDS constant exists');
  const body = m ? stripJsComments(m[1]) : '';
  assert(!/['"]user['"]/.test(body),
    'CART_PUBLIC_FIELDS does NOT include "user"');
  for (const required of ['id', 'items', 'formData', 'sourceProjectId']) {
    assert(new RegExp(`['"]${required}['"]`).test(body),
      `CART_PUBLIC_FIELDS includes '${required}'`);
  }
}

out('\n=== B. sanitizeCartForResponse correctness ===');

// B1. Exists and uses an allow-list (not deny-list)
{
  const fn = CART.match(/function sanitizeCartForResponse[\s\S]*?\n\}/);
  const body = fn ? fn[0] : '';
  assert(/for\s*\(\s*const\s+k\s+of\s+CART_PUBLIC_FIELDS/.test(body),
    'sanitizeCartForResponse iterates CART_PUBLIC_FIELDS (allow-list)');
  // Allow-list pattern — anything not in the list is dropped. No need
  // to enumerate denied keys, but verify the function body doesn't
  // accidentally pass through unknown fields.
  assert(/return\s+out/.test(body),
    'sanitizeCartForResponse returns the new shape, not the input');
}

out('\n=== C. Every cart handler runs its return through the sanitizer ===');

// C1. getUserCart — main reported leak
{
  const fn = CART.match(/async getUserCart\(ctx\)[\s\S]*?^\s\s\},/m);
  const body = fn ? fn[0] : '';
  assert(/return\s+sanitizeCartForResponse\(/.test(body),
    'getUserCart return is sanitized');
  // Also verify the DB query uses `select` (the right knob for db.query)
  // rather than `fields:` (which db.query silently ignores — same bug
  // class as the wallet/transactions incident).
  assert(/select:\s*CART_PUBLIC_FIELDS/.test(body),
    'getUserCart db.query uses `select: CART_PUBLIC_FIELDS` (the right shape for db.query)');
}

// C2. updateCart — secondary path
{
  const fn = CART.match(/async updateCart\(ctx\)[\s\S]*?^\s\s\},/m);
  const body = fn ? fn[0] : '';
  assert(/return\s+sanitizeCartForResponse\(/.test(body),
    'updateCart return is sanitized');
  // No `populate: ['user']` resurrected by accident
  assert(!/populate:\s*\[/.test(stripJsComments(body)),
    'updateCart has no broad populate');
}

// C3. clearCart returns a hand-crafted shape (no user data) — verify
// nothing introduces a populate
{
  const fn = CART.match(/async clearCart\(ctx\)[\s\S]*?^\s\s\},/m);
  const body = fn ? fn[0] : '';
  assert(!/populate:\s*\[/.test(stripJsComments(body)),
    'clearCart has no populate');
}

out('\n=== D. Belt-and-braces: no PII field names referenced as response values ===');

// D1. None of the well-known leak field names appear as part of an
// output object literal in cart.js (e.g. `email: cart.user?.email`).
// Allow them inside email-dispatch code (user.email used for AutoSend
// recipient at line ~135 / 184 — server-side only) but flag any output
// object construction that mentions them.
{
  const noComments = CART_NO_COMMENTS;
  // Look for OBJECT-LITERAL output like `email: cart.user...` or
  // `{ id: x, email: y }`. The legitimate use is `user.email` as a
  // function arg, which is a single identifier expression — not an
  // object literal.
  const offenders = [];
  const objectLeakRe = /(?:^|[,{(])\s*(email|username|clerkId|password|resetPasswordToken|confirmationToken|confirmed|blocked|provider)\s*:\s*(?!\{)/gm;
  let m;
  while ((m = objectLeakRe.exec(noComments)) !== null) {
    const ctx = noComments.slice(Math.max(0, m.index - 40), m.index + 80).replace(/\n/g, ' ');
    // Allow the AutoSend dispatch which uses { email: user.email, listId } — that's
    // a SERVER-TO-SERVER request body, not a response. Distinguish by checking for
    // 'addToList' or 'removeFromList' nearby.
    if (/addToList|removeFromList|listId/.test(ctx)) continue;
    offenders.push(`'${m[1]}' near: ...${ctx}...`);
  }
  assert(offenders.length === 0,
    `no PII field names assembled into response objects (offenders: ${offenders.length ? offenders.join(' | ') : 'none'})`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
