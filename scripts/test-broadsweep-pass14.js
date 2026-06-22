#!/usr/bin/env node
/**
 * Regression test — broadsweep pass 14: ops follow-ups.
 *
 * Closes:
 *   - CRITICAL (unauth-email-webhook-spoof / mw-find-email-webhook-anon):
 *     POST /api/email/webhook was anonymously reachable with NO signature
 *     verification. Downstream parseEmailCommand+executeEmailCommand
 *     trusted the request `from` field as user identity and ran
 *     CONFIRM-PAYMENT / ACCEPT / REJECT / APPROVE / DISPUTE / DELIVER /
 *     COMPLETE under that user. An attacker who knew an advertiser's
 *     email (purchase history, marketplace scraping) could spoof the
 *     `from` field and trigger order-state changes on the victim's
 *     orders. Now: EMAIL_WEBHOOK_SECRET shared bearer required;
 *     timingSafeEqual comparison; failure logs caller IP; fail-closed
 *     when secret unset. Full-body request log also removed.
 *
 *   - MEDIUM (mw-find-ratelimit-missing-on-sensitive): per-IP rate
 *     limits applied via global::simple-rate-limit policy to the five
 *     sensitive PUBLIC endpoints:
 *       - POST /auth/send-email-confirmation     (5 / 5min)
 *       - GET  /reseller-codes/validate/:code    (20 / min)
 *       - POST /payment-gateways/calculate-fees  (30 / min)
 *       - POST /api/exit-intent-leads            (5 / 10min)
 *
 *   - MEDIUM (log-find-stripe-fullevent): stripe-webhook dumped the
 *     full JSON.stringify(event) for unknown event types. Removed —
 *     log only the event-type label.
 *
 *   - LOW (log-find-export-csv-body): marketplace.export-csv.exportSelected
 *     logged ctx.request.body (potentially long ids array). Removed.
 *
 *   - LOW (log-find-marketplace-list-body): marketplace-list.update
 *     logged the full payload. Trimmed to id + user id.
 *
 * Static-grep test — no Strapi load.
 * Run: cd serpbays_server && node scripts/test-broadsweep-pass14.js
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

const EOPS = read('src/api/global/controllers/email-operations.js');
const ECNF = read('src/api/auth/routes/email-confirmation.js');
const RESL = read('src/api/reseller-code/routes/custom-routes.js');
const PG   = read('src/api/payment-gateways/routes/payment-gateways.js');
const EIL  = read('src/api/exit-intent-lead/routes/exit-intent-lead.js');
const STR  = read('src/api/transaction/controllers/stripe-webhook.js');
const ML   = read('src/api/marketplace-list/controllers/marketplace-list.js');
const ECSV = read('src/api/marketplace/controllers/export-csv.js');

out('\n=== 1) /api/email/webhook — fail-closed shared secret + body-log removed ===');
const eopsCode = EOPS.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const ehStart = EOPS.indexOf('async handleIncomingEmail(ctx)');
const ehEnd   = EOPS.indexOf('async processEmailCommand(ctx)');
const eh      = ehStart > 0 && ehEnd > ehStart ? EOPS.slice(ehStart, ehEnd) : '';
assert(eh.length > 0, 'handleIncomingEmail body sliced');
assert(/process\.env\.EMAIL_WEBHOOK_SECRET/.test(eh),
  'reads EMAIL_WEBHOOK_SECRET from env');
assert(/!expected\s*\|\|\s*expected\.length\s*<\s*16/.test(eh),
  'fails closed when secret missing or weak (<16 chars)');
assert(/crypto\.timingSafeEqual\s*\(/.test(eh),
  'uses timingSafeEqual for the secret comparison');
assert(/x-webhook-secret/.test(eh.toLowerCase()) || /X-Webhook-Secret/.test(EOPS),
  'reads the secret from X-Webhook-Secret header (or Authorization Bearer)');
// Full-body log gone.
const ehCode = eh.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/console\.log\(\s*['"]Received email webhook:?['"]\s*,\s*JSON\.stringify/.test(ehCode),
  "no remaining 'Received email webhook' JSON.stringify body dump");
// Failure path does not echo error.message in the HTTP response body.
// (strapi.log.error(..., {error: error.message}) is server-side logging
// — that's fine.)
assert(!/ctx\.body\s*=\s*\{[\s\S]{0,100}error:\s*error\.message|ctx\.send\([^)]*error\.message|ctx\.badRequest\([^)]*error\.message|ctx\.internalServerError\([^)]*error\.message/.test(ehCode),
  'webhook handler no longer echoes error.message in HTTP response body');

out('\n=== 2) /auth/send-email-confirmation — rate limit attached ===');
assert(/path:\s*'\/auth\/send-email-confirmation'[\s\S]{0,800}global::simple-rate-limit/.test(ECNF),
  'send-email-confirmation has global::simple-rate-limit policy');
assert(/path:\s*'\/auth\/send-email-confirmation'[\s\S]{0,800}max:\s*5\b[\s\S]{0,200}interval:\s*300000/.test(ECNF),
  'limit configured as 5 / 5min');

out('\n=== 3) /reseller-codes/validate/:code — rate limit attached ===');
assert(/path:\s*'\/reseller-codes\/validate\/:code'[\s\S]{0,800}global::simple-rate-limit/.test(RESL),
  'reseller-code validate has global::simple-rate-limit policy');
assert(/path:\s*'\/reseller-codes\/validate\/:code'[\s\S]{0,800}max:\s*20\b/.test(RESL),
  'limit configured as 20 / min');

out('\n=== 4) /payment-gateways/calculate-fees — rate limit attached ===');
assert(/path:\s*'\/payment-gateways\/calculate-fees'[\s\S]{0,800}global::simple-rate-limit/.test(PG),
  'calculate-fees has global::simple-rate-limit policy');
assert(/path:\s*'\/payment-gateways\/calculate-fees'[\s\S]{0,800}max:\s*30\b/.test(PG),
  'limit configured as 30 / min');

out('\n=== 5) /api/exit-intent-leads (default create) — rate limit attached ===');
assert(/create:\s*\{[\s\S]{0,1200}global::simple-rate-limit/.test(EIL),
  'exit-intent-lead create has global::simple-rate-limit policy');
assert(/create:\s*\{[\s\S]{0,1200}max:\s*5\b[\s\S]{0,400}interval:\s*600000/.test(EIL),
  'limit configured as 5 / 10min');

out('\n=== 6) Stripe webhook — JSON.stringify(event) dump removed ===');
const strCode = STR.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/console\.log\(`\[STRIPE WEBHOOK\] Event data:`,\s*JSON\.stringify\(event/.test(strCode),
  'Event data JSON.stringify dump removed from default case');

out('\n=== 7) marketplace-list.update body log trimmed ===');
const mlCode = ML.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/console\.log\(['"`]📝 UPDATE request received[\s\S]{0,200}data:\s*ctx\.request\.body\.data/.test(mlCode),
  'no longer dumps ctx.request.body.data');
assert(/strapi\.log\??\.info\??\.\(`\[marketplace-list\] update id=/.test(ML),
  'replaced with id + user.id-only structured log');

out('\n=== 8) export-csv.exportSelected body log removed ===');
const ecsvCode = ECSV.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
assert(!/console\.log\(['"]Export selected called with body['"]\s*,\s*ctx\.request\.body/.test(ecsvCode),
  "no remaining 'Export selected called with body' log");

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
