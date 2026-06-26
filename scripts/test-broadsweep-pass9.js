#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 9: promo-code + offer-usage + wallet.js cleanup.
 *
 * Findings closed:
 *   - CATASTROPHIC: wallet.addPromoFunds was a free-money primitive
 *     (Authenticated had `api::user-wallet.wallet.addPromoFunds` permission;
 *     handler took caller-supplied {amount} and credited promoBalance
 *     directly). Now returns 410 Gone.
 *   - HIGH: wallet.getWallet had a `NODE_ENV !== 'production'` bypass that
 *     returned an arbitrary wallet (via findOne({}) with no filter) to
 *     anonymous callers. The handler was not routed today but the trap
 *     would have been instantly armed by any future routing change. Same
 *     class as the Stripe dev-bypass removed in Pass 5. Handler deleted
 *     along with other dead/dangerous wallet.js handlers.
 *   - HIGH: wallet.createTransaction handler accepted caller-supplied
 *     `amount`/`status` and wrote success-status transaction rows directly.
 *     Same free-money class. Dead code, removed.
 *   - MEDIUM: user-wallet.checkPromoCode had no in-handler auth check and
 *     no length validation on the code. Added explicit ctx.state.user
 *     gate + 64-char cap. Brute-force still possible but now requires
 *     an authenticated account (traceable).
 *   - LOW: redeemPromo / checkPromoCode error.message echoes removed;
 *     server-side log only.
 *
 * Note on promo-code / offer-usage / offer-condition content types:
 *   These have NO controllers/routes/services directories — they are
 *   data containers consumed only by offer-engine service + redeemPromo
 *   handler. up_permissions has NO HTTP-accessible permissions on these
 *   content types (confirmed via DB query). They have no external attack
 *   surface as long as no new routes are added.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass9.js
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
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const W   = read('src/api/user-wallet/controllers/wallet.js');
const UW  = read('src/api/user-wallet/controllers/user-wallet.js');

out('\n=== 1) wallet.addPromoFunds — HTTP path DISABLED ===');
const apfStart = W.indexOf('async addPromoFunds(ctx)');
const apfEnd   = W.length;
const apf      = apfStart > 0 ? W.slice(apfStart, apfEnd) : '';
assert(apf.length > 0, 'addPromoFunds body sliced');
// Must NOT call the internal addPromoFunds helper anymore (free-money primitive)
assert(!/strapi\.controller\([^)]*\)\.addPromoFunds\(/.test(apf),
  'addPromoFunds HTTP wrapper no longer invokes the internal credit helper');
assert(/ctx\.status\s*=\s*410/.test(apf),
  'returns HTTP 410 Gone');
assert(/strapi\.log\??\.warn/.test(apf),
  'warns server-side on any call');
// Body destructure must NOT pull caller-supplied amount
assert(!/const\s*\{[^}]*amount[^}]*\}\s*=\s*ctx\.request\.body/.test(apf),
  'no longer destructures amount from request body');

out('\n=== 2) wallet.js dead/dangerous handlers removed ===');
const wCode = W.split('\n').map(l => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')).join('\n');
// getWallet / createTransaction / listTransactions / redeemPromoCode /
// validatePromoCode are all REMOVED as code (comments documenting them
// remain at the top of the file).
for (const ghost of ['getWallet', 'createTransaction', 'listTransactions', 'redeemPromoCode', 'validatePromoCode']) {
  assert(!new RegExp(`async\\s+${ghost}\\s*\\(`).test(wCode),
    `handler '${ghost}' removed from code`);
}
// And the NODE_ENV bypass pattern from the prior getWallet is gone.
assert(!/NODE_ENV\s*!==?\s*'production'/.test(wCode),
  'no NODE_ENV branch in wallet.js (was the anonymous-wallet bypass)');
assert(!/strapi\.db\.query\('api::user-wallet\.user-wallet'\)\.findOne\(\{\}\)/.test(wCode),
  'no findOne({}) (was returning an arbitrary wallet to anonymous callers)');

out('\n=== 3) user-wallet.checkPromoCode — auth gate + length cap ===');
const cpStart = UW.indexOf('async checkPromoCode(ctx)');
const cpEnd   = UW.indexOf('async addMainFunds(userId,');
const cp      = cpStart > 0 && cpEnd > cpStart ? UW.slice(cpStart, cpEnd) : '';
assert(cp.length > 0, 'checkPromoCode body sliced');
assert(/if\s*\(\s*!userId\s*\)[\s\S]{0,80}ctx\.unauthorized/.test(cp),
  'checkPromoCode rejects unauthenticated callers');
assert(/typeof\s+promoCode\s*!==\s*'string'\s*\|\|\s*promoCode\.length\s*===\s*0\s*\|\|\s*promoCode\.length\s*>\s*64/.test(cp),
  'checkPromoCode rejects pathological inputs (length-capped at 64)');
// Strip JS line-comments so the comment block explaining the prior behaviour
// doesn't false-positive.
const cpCode = cp.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/ctx\.badRequest\([^)]*error\.message|ctx\.internalServerError\([^)]*error\.message/.test(cpCode),
  'checkPromoCode no longer echoes error.message in HTTP response');

out('\n=== 4) user-wallet.redeemPromo — error.message no longer echoed ===');
const rpStart = UW.indexOf('async redeemPromo(ctx)');
const rpEnd   = UW.indexOf('async checkPromoCode(ctx)');
const rp      = rpStart > 0 && rpEnd > rpStart ? UW.slice(rpStart, rpEnd) : '';
assert(rp.length > 0, 'redeemPromo body sliced');
// Pre-fix had `return ctx.badRequest(error.message || ...)` in the catch.
assert(!/ctx\.badRequest\(error\.message/.test(rp),
  'redeemPromo no longer echoes error.message in HTTP response');
// Critical: row-level lock + idempotency checks already in place from earlier waves
assert(/\.forUpdate\(\)/.test(rp),
  'redeemPromo retains .forUpdate() row lock on promo/voucher row');
assert(/Duplicate promo redemption/.test(rp),
  'redeemPromo retains DB-trigger duplicate-prevention handler');

out('\n=== 5) Schema-only content types have no HTTP attack surface ===');
// promo-code / offer-usage / offer-condition have schemas only — no
// controllers/routes/services. Verify the directories still look that way.
for (const t of ['promo-code', 'offer-usage', 'offer-condition']) {
  assert(!exists(`src/api/${t}/routes/${t}.js`),
    `${t}: no default route file`);
  assert(!exists(`src/api/${t}/controllers/${t}.js`),
    `${t}: no controller file (consumed only via offer-engine service)`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
