#!/usr/bin/env node
/**
 * Regression test — PII pass 1 (wallet/orders response sanitization).
 *
 * Static-grep checks that the user-facing read endpoints can never leak
 * publisher PII (`websitePublisherEmail` / `websitePublisherName` /
 * `publisher_email` / `publisher_name`) or opaque snapshot blobs
 * (`websiteSnapshot` / `metadata`) into the response.
 *
 * Why static rather than HTTP: a real-HTTP regression would need a
 * stable test JWT + seeded DB, neither of which the runtime has. The
 * controller-level invariants checked here are equivalent: if the
 * sanitizer is wired into every response path AND the allow-list
 * constants exclude PII, then no response can carry PII.
 *
 * Run: cd serpbays_server && node scripts/test-pii-pass1.js
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

const WALLET  = read('src/api/user-wallet/controllers/user-wallet.js');
const ORDER   = read('src/api/order/controllers/order.js');

out('\n=== A. wallet/transactions — root-cause defenses ===');

// A1. The buggy pattern (db.query.findWithCount with nested populate.X.fields)
// must NOT come back. Strapi 5's db.query silently ignores the nested
// fields allow-list — that's how the leak happened the first time.
{
  // Find every strapi.db.query(...).findWithCount call and assert it
  // does not have a `populate: { X: { fields: [...] } }` block in its
  // arg literal.
  const re = /strapi\.db\.query\([^)]*api::transaction[^)]*\)\.findWithCount\(\{[\s\S]{0,800}?\}\)/g;
  let m, anyBad = false;
  while ((m = re.exec(WALLET))) {
    if (/populate\s*:\s*\{[\s\S]*?fields\s*:\s*\[/.test(m[0])) { anyBad = true; break; }
  }
  assert(!anyBad,
    'wallet: no db.query.findWithCount with nested populate.X.fields (silent-ignore bug)');
}

// A2. getTransactions uses entityService (which respects nested fields)
{
  const fn = WALLET.match(/async getTransactions\(ctx\)\s*\{[\s\S]*?\n\s\s\},/);
  assert(fn && /strapi\.entityService\.findMany\(['"]api::transaction\.transaction['"]/.test(fn[0]),
    'getTransactions uses entityService.findMany (db.query silently drops nested fields)');
}

// A3. getTransactions calls the sanitizer on every row
{
  const fn = WALLET.match(/async getTransactions\(ctx\)\s*\{[\s\S]*?\n\s\s\},/);
  assert(fn && /\.map\(sanitizeTransactionForResponse\)|for[\s\S]{0,40}sanitizeTransactionForResponse/.test(fn[0]),
    'getTransactions runs every row through sanitizeTransactionForResponse');
}

// A4. The sanitizer reduces tx.order to { id } only
{
  const fn = WALLET.match(/function sanitizeTransactionForResponse[\s\S]*?^\}/m);
  assert(fn && /tx\.order\s*=\s*\{\s*id:\s*tx\.order\.id\s*\}/.test(fn[0]),
    'sanitizer reduces tx.order to { id } (drops websitePublisher* / websiteSnapshot / metadata)');
}

// A5. The sanitizer reduces tx.invoice to id/invoiceNumber/pdfUrl only
{
  const fn = WALLET.match(/function sanitizeTransactionForResponse[\s\S]*?^\}/m);
  assert(fn && /tx\.invoice\s*=\s*\{[\s\S]{0,200}invoiceNumber/.test(fn[0]),
    'sanitizer reduces tx.invoice to allow-list');
}

// A6. TRANSACTION_PUBLIC_FIELDS does NOT include obvious internal columns
{
  const m = WALLET.match(/const TRANSACTION_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const list = m ? m[1] : '';
  for (const bad of ['metadata', 'promo_code_id', 'email_sent_at']) {
    assert(!new RegExp(`['"]${bad}['"]`).test(list),
      `TRANSACTION_PUBLIC_FIELDS excludes '${bad}'`);
  }
}

// A7. Schema conformance — every name in TRANSACTION_PUBLIC_FIELDS must
// be a real attribute on api::transaction.transaction. Strapi 5's
// query-fields validator throws `ValidationError: Invalid key <name>`
// on unknown keys, and the controller's bare `catch` turns that into
// a 400 with no further info. This assertion catches the same class
// of bug that broke /api/api/wallet/transactions on 2026-06-25 when
// `balanceAfter` (not a schema attribute) was added to the list.
//
// Strapi 5 auto-adds these as virtual attributes regardless of
// schema.json: id, documentId, createdAt, updatedAt. `publishedAt`
// exists ONLY when the schema has `options.draftAndPublish: true`.
function validQueryAttrs(schema) {
  const set = new Set(['id', 'documentId', 'createdAt', 'updatedAt', ...Object.keys(schema.attributes)]);
  if (schema.options?.draftAndPublish) set.add('publishedAt');
  return set;
}
{
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const m = WALLET.match(/const TRANSACTION_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const declared = m
    ? Array.from(stripComments(m[1]).matchAll(/['"]([^'"]+)['"]/g)).map(x => x[1])
    : [];
  const schema = require('/var/www/serpbays/serpbays_server/src/api/transaction/content-types/transaction/schema.json');
  const schemaAttrs = validQueryAttrs(schema);
  const bogus = declared.filter(k => !schemaAttrs.has(k));
  assert(bogus.length === 0,
    `TRANSACTION_PUBLIC_FIELDS contains only real schema attributes (bogus: [${bogus.join(', ')}])`);
}

out('\n=== B. /api/orders family — sanitizer wiring ===');

// B1. sanitizeOrderResponse calls stripOrderForResponse, which iterates
// the ORDER_SNAPSHOT_PUBLISHER_PRIVATE list — so the websitePublisher*
// snapshot fields are removed via that indirection.
{
  const sanitize = ORDER.match(/function sanitizeOrderResponse[\s\S]*?^\}/m);
  const strip    = ORDER.match(/function stripOrderForResponse[\s\S]*?^\}/m);
  const constDef = ORDER.match(/const ORDER_SNAPSHOT_PUBLISHER_PRIVATE\s*=\s*\[([\s\S]*?)\]/);
  const list = constDef ? constDef[1] : '';
  assert(sanitize && /stripOrderForResponse\(order\)/.test(sanitize[0]),
    'sanitizeOrderResponse delegates to stripOrderForResponse');
  assert(strip && /ORDER_SNAPSHOT_PUBLISHER_PRIVATE/.test(strip[0]),
    'stripOrderForResponse iterates ORDER_SNAPSHOT_PUBLISHER_PRIVATE');
  for (const k of ['websitePublisherEmail', 'websitePublisherName', 'websitePublisherPrice']) {
    assert(new RegExp(`['"]${k}['"]`).test(list),
      `ORDER_SNAPSHOT_PUBLISHER_PRIVATE includes '${k}'`);
  }
}

// B2. sanitizeOrderResponse clips order.website to the public allow-list
{
  const fn = ORDER.match(/function sanitizeOrderResponse[\s\S]*?^\}/m);
  assert(fn && /WEBSITE_PUBLIC_FIELD_SET\.has|WEBSITE_PUBLIC_FIELDS/.test(fn[0]),
    'sanitizeOrderResponse clips order.website to WEBSITE_PUBLIC_FIELDS');
}

// B3. sanitizeOrderResponse replaces order.advertiser / order.publisher with { id }
{
  const fn = ORDER.match(/function sanitizeOrderResponse[\s\S]*?^\}/m);
  assert(fn && /order\.advertiser\s*=\s*\{\s*id:/.test(fn[0]),
    'sanitizeOrderResponse reduces order.advertiser to { id }');
  assert(fn && /order\.publisher\s*=\s*\{\s*id:/.test(fn[0]),
    'sanitizeOrderResponse reduces order.publisher to { id }');
}

// B4. WEBSITE_PUBLIC_FIELDS excludes publisher_email / publisher_name and every publisher_*_pricing
{
  const m = ORDER.match(/const WEBSITE_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const list = m ? m[1] : '';
  assert(!/publisher_email/.test(list),
    'WEBSITE_PUBLIC_FIELDS excludes publisher_email');
  assert(!/publisher_name/.test(list),
    'WEBSITE_PUBLIC_FIELDS excludes publisher_name');
  assert(!/publisher_(price|forbidden|writing|crypto|casino|cbd|dating|link_insertion|li_)/.test(list),
    'WEBSITE_PUBLIC_FIELDS excludes every publisher_* intake-pricing column');
  assert(!/gsc_refresh_token/.test(list),
    'WEBSITE_PUBLIC_FIELDS excludes gsc_refresh_token');
}

// B5. ORDER_PUBLIC_FIELDS excludes admin-only / opaque blob columns
{
  const m = ORDER.match(/const ORDER_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const list = m ? m[1] : '';
  for (const bad of ['websiteSnapshot', 'metadata', 'createdByAdminId', 'adminReason',
                     'userConsentType', 'userConsentReference', 'warningNotificationSentAt']) {
    assert(!new RegExp(`['"]${bad}['"]`).test(list),
      `ORDER_PUBLIC_FIELDS excludes '${bad}'`);
  }
}

// B6. Every order response path calls sanitizeOrderResponse
{
  // Each user-facing handler that returns `{ data: ... }` should have a
  // sanitize call. Sample a few of the named return shapes:
  for (const name of ['populatedOrder', 'completedOrder', 'updatedOrder', 'existingOrder']) {
    const re = new RegExp(`data:\\s*sanitizeOrderResponse\\(${name}\\)|data:\\s*${name}\\b`);
    const m = re.exec(ORDER);
    if (m) {
      assert(m[0].includes('sanitizeOrderResponse'),
        `order response '${name}' is sanitized (not raw)`);
    }
  }
}

// B7. The find / findOne / getMyOrders / getAvailableOrders read endpoints sanitize
{
  for (const fn of ['async find\\(', 'async findOne\\(', 'async getMyOrders\\(', 'async getAvailableOrders\\(']) {
    const m = ORDER.match(new RegExp(`${fn}[\\s\\S]*?\\n {4,6}\\},`));
    const body = m ? m[0] : '';
    assert(/sanitizeOrderResponse/.test(body),
      `${fn.replace('\\(','')} ) calls sanitizeOrderResponse`);
  }
}

out('\n=== B8. Schema conformance for order field allow-lists ===');

// Same class of bug as A7 — ensure every key exists on the schema. Uses
// validQueryAttrs() to account for Strapi 5 auto-attributes.
//
// Strip `//` line comments and `/* */` block comments before scanning
// for string literals — otherwise apostrophes inside comments
// (e.g. "don't exist") show up as "string" matches and ruin the diff.
const stripJsComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
{
  const schema = require('/var/www/serpbays/serpbays_server/src/api/order/content-types/order/schema.json');
  const schemaAttrs = validQueryAttrs(schema);
  const pickList = (name) => {
    const m = ORDER.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    if (!m) return [];
    return Array.from(stripJsComments(m[1]).matchAll(/['"]([^'"]+)['"]/g)).map(x => x[1]);
  };
  const publicList   = pickList('ORDER_PUBLIC_FIELDS');
  const snapshotList = pickList('ORDER_SNAPSHOT_PUBLISHER_PRIVATE');
  const fetchList    = [...publicList, ...snapshotList];
  const bogusPub   = publicList.filter(k => !schemaAttrs.has(k));
  const bogusFetch = fetchList.filter(k => !schemaAttrs.has(k));
  assert(bogusPub.length === 0,
    `ORDER_PUBLIC_FIELDS contains only real schema attributes (bogus: [${bogusPub.join(', ')}])`);
  assert(bogusFetch.length === 0,
    `ORDER_FETCH_FIELDS (resolved) contains only real schema attributes (bogus: [${bogusFetch.join(', ')}])`);
}

// B9. Schema conformance for WEBSITE_PUBLIC_FIELDS (marketplace schema)
{
  const schema = require('/var/www/serpbays/serpbays_server/src/api/marketplace/content-types/marketplace/schema.json');
  const schemaAttrs = validQueryAttrs(schema);
  const m = ORDER.match(/const WEBSITE_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const declared = m
    ? Array.from(stripJsComments(m[1]).matchAll(/['"]([^'"]+)['"]/g)).map(x => x[1])
    : [];
  const bogus = declared.filter(k => !schemaAttrs.has(k));
  assert(bogus.length === 0,
    `WEBSITE_PUBLIC_FIELDS contains only real marketplace schema attributes (bogus: [${bogus.join(', ')}])`);
}

out('\n=== C. Audit — no broad populates left in user-facing read paths ===');

// C1. user-wallet.getTransactions has no `populate: ['order']` (string-form)
{
  const m = WALLET.match(/async getTransactions\(ctx\)\s*\{[\s\S]*?\n\s\s\},/);
  assert(m && !/populate:\s*\[\s*['"]order['"]/.test(m[0]),
    'getTransactions has no string-form populate of order');
}

// C2. user-wallet.getAvailableBalance uses field-allow-listed populate
{
  const m = WALLET.match(/async getAvailableBalance\(ctx\)[\s\S]*?\n\s\s\},/);
  assert(m && /populate:\s*\{\s*order:\s*\{\s*fields:\s*\[\s*['"]id['"]\s*\]\s*\}\s*\}/.test(m[0]),
    'getAvailableBalance populate.order is fields:[id]');
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
