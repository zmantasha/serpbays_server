#!/usr/bin/env node
/**
 * Regression test — PII pass 6 (shortlist endpoint IDOR via nested populate).
 *
 * Static-grep checks that /api/shortlists ignores caller-supplied
 * `populate` and only returns marketplace fields from a server-defined
 * allow-list. Same vulnerability class as pass-5 (marketplace IDOR)
 * but via an adjacent endpoint that bypassed the marketplace sanitizer.
 *
 * Pre-fix:
 *   populate: ctx.query.populate || ['marketplace']
 *   → ?populate[marketplace][populate]=* returned the full marketplace
 *     row + populated publisher user object (PII leak).
 *
 * Post-fix:
 *   populate: { marketplace: { fields: SHORTLIST_MARKETPLACE_FIELDS } }
 *   → caller's `populate` is ignored; only the allow-listed fields
 *     reach the response.
 *
 * Run: cd serpbays_server && node scripts/test-pii-pass6.js
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
const stripJsComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SHORTLIST = read('src/api/shortlist/controllers/shortlist.js');
const SL_NO_COMMENTS = stripJsComments(SHORTLIST);

out('\n=== A. SHORTLIST_MARKETPLACE_FIELDS allow-list exists + is strict ===');

assert(/const SHORTLIST_MARKETPLACE_FIELDS\s*=\s*\[/.test(SHORTLIST),
  'SHORTLIST_MARKETPLACE_FIELDS constant defined');

// A2. Must NOT contain publisher PII / intake pricing / internal admin state
{
  const m = SHORTLIST.match(/const SHORTLIST_MARKETPLACE_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const list = m ? stripJsComments(m[1]) : '';
  for (const bad of [
    'publisher_email', 'publisher_name',
    'publisher_price', 'publisher_writing_price',
    'publisher_link_insertion_price',
    'publisher_casino_pricing', 'publisher_cbd_pricing',
    'publisher_crypto_pricing', 'publisher_dating_pricing',
    'publisher_forbidden_gp_price', 'publisher_forbidden_li_price',
    'gsc_refresh_token', 'gsc_permission_level',
    'approvalStatus', 'blacklist_status', 'dataVersion',
    'lastAhrefsRefreshAt', 'lastMozRefreshAt',
  ]) {
    assert(!new RegExp(`['"]${bad}['"]`).test(list),
      `SHORTLIST_MARKETPLACE_FIELDS does NOT contain '${bad}'`);
  }
}

// A3. Must include the public fields the client UI consumes
{
  const m = SHORTLIST.match(/const SHORTLIST_MARKETPLACE_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const list = m ? stripJsComments(m[1]) : '';
  for (const required of [
    'id', 'url', 'price', 'category',
    'ahrefs_traffic', 'moz_da', 'ahrefs_dr',
    'description', 'min_word_count', 'guidelines',
    'backlink_validity', 'dofollow_link',
  ]) {
    assert(new RegExp(`['"]${required}['"]`).test(list),
      `SHORTLIST_MARKETPLACE_FIELDS includes '${required}'`);
  }
}

out('\n=== B. find() ignores caller-controlled populate ===');

// B1. The vulnerable pattern is gone
assert(!/populate:\s*ctx\.query\.populate/.test(SL_NO_COMMENTS),
  "no `populate: ctx.query.populate` pattern remains");

// B2. find() uses the server-defined allow-list
{
  const fn = SHORTLIST.match(/async find\(ctx\)[\s\S]*?^  \},/m);
  const body = fn ? fn[0] : '';
  assert(/populate:\s*\{\s*marketplace:\s*\{\s*fields:\s*SHORTLIST_MARKETPLACE_FIELDS\s*\}\s*\}/.test(body),
    'find() populate is { marketplace: { fields: SHORTLIST_MARKETPLACE_FIELDS } }');
}

// B3. ...ctx.query spread is gone (was the smuggling vector for populate)
{
  const fn = SHORTLIST.match(/async find\(ctx\)[\s\S]*?^  \},/m);
  const body = fn ? fn[0] : '';
  assert(!/\.\.\.\s*ctx\.query/.test(body),
    'find() no longer spreads ...ctx.query (closes populate-smuggling vector)');
}

// B4. find() still enforces owner filter (defense-in-depth IDOR check)
{
  const fn = SHORTLIST.match(/async find\(ctx\)[\s\S]*?^  \},/m);
  const body = fn ? fn[0] : '';
  assert(/owner:\s*\{[\s\S]{0,40}id:\s*user\.id/.test(body),
    'find() filter scopes results to the caller (owner: user.id)');
}

out('\n=== C. Schema conformance for SHORTLIST_MARKETPLACE_FIELDS ===');

// C1. Every name in the allow-list must be a real marketplace attribute
{
  const schema = require('/var/www/serpbays/serpbays_server/src/api/marketplace/content-types/marketplace/schema.json');
  const validAttrs = new Set([
    'id', 'documentId', 'createdAt', 'updatedAt',
    ...Object.keys(schema.attributes),
  ]);
  if (schema.options?.draftAndPublish) validAttrs.add('publishedAt');

  const m = SHORTLIST.match(/const SHORTLIST_MARKETPLACE_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const declared = m
    ? Array.from(stripJsComments(m[1]).matchAll(/['"]([^'"]+)['"]/g)).map(x => x[1])
    : [];
  const bogus = declared.filter(k => !validAttrs.has(k));
  assert(bogus.length === 0,
    `SHORTLIST_MARKETPLACE_FIELDS contains only real marketplace attributes (bogus: [${bogus.join(', ')}])`);
}

out('\n=== D. Other shortlist handlers are still tight ===');

// D1. findOne still scopes to owner
{
  const fn = SHORTLIST.match(/async findOne\(ctx\)[\s\S]*?^  \},/m);
  const body = fn ? fn[0] : '';
  assert(/record\.owner\?\.id\s*!==\s*user\.id/.test(body),
    'findOne enforces owner check');
  assert(!/populate:\s*ctx\.query/.test(body),
    'findOne does not honor caller-controlled populate');
}

// D2. update is forbidden
{
  const fn = SHORTLIST.match(/async update\(ctx\)[\s\S]*?^  \},/m);
  const body = fn ? fn[0] : '';
  assert(/ctx\.forbidden/.test(body),
    'update() is forbidden (read-only collection)');
}

// D3. delete still scopes to owner
{
  const fn = SHORTLIST.match(/async delete\(ctx\)[\s\S]*?^  \}\s*\}/m);
  const body = fn ? fn[0] : '';
  assert(/owner:\s*user\.id/.test(body),
    'delete() scopes to caller (owner: user.id)');
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
