#!/usr/bin/env node
/**
 * Regression test — PII pass 3 (project endpoints).
 *
 * Static-grep checks that /api/projects/* never leaks user PII through
 * the `owner` / `team` relations. Same pattern as pass-1 (wallet/orders)
 * and pass-2 (chat).
 *
 * Run: cd serpbays_server && node scripts/test-pii-pass3.js
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
function validQueryAttrs(schema) {
  const set = new Set(['id', 'documentId', 'createdAt', 'updatedAt', ...Object.keys(schema.attributes)]);
  if (schema.options?.draftAndPublish) set.add('publishedAt');
  return set;
}

const PROJECT = read('src/api/project/controllers/project.js');

out('\n=== A. /api/projects/my/all (the reported leak) ===');

// A1. Constants exist and are strict
{
  const m = PROJECT.match(/const PROJECT_USER_FIELDS\s*=\s*\[([^\]]*)\]/);
  assert(m && /^\s*['"]id['"]\s*$/.test(m[1]),
    'PROJECT_USER_FIELDS = ["id"] (no username/email)');
}

// A2. No remaining email/username allow-list in project.js
assert(!/fields:\s*\[[^\]]*['"](email|username)/.test(PROJECT),
  'no fields allow-list mentions email or username');

// A3. No remaining string-form populate of owner/team (string-form returns full user record)
assert(!/populate:\s*\[[^\]]*['"](owner|team)['"]/.test(PROJECT),
  'no string-form populate of owner/team remains');

// A4. getMyProjects uses the standard list populate
{
  const fn = PROJECT.match(/async getMyProjects\(ctx\)[\s\S]*?^\s\s\},/m);
  const body = fn ? fn[0] : '';
  assert(/populate:\s*PROJECT_LIST_POPULATE/.test(body),
    'getMyProjects uses PROJECT_LIST_POPULATE');
  assert(/fields:\s*PROJECT_PUBLIC_FIELDS/.test(body),
    'getMyProjects scoped to PROJECT_PUBLIC_FIELDS');
  assert(/\.map\(sanitizeProjectResponse\)/.test(body),
    'getMyProjects response runs every row through sanitizeProjectResponse');
}

out('\n=== B. sanitizeProjectResponse correctness ===');

// B1. Exists and clips owner to { id }
{
  const fn = PROJECT.match(/function sanitizeProjectResponse[\s\S]*?\n\}/);
  const body = fn ? fn[0] : '';
  assert(/project\.owner\s*=\s*\{\s*id:\s*project\.owner\.id\s*\}/.test(body),
    'sanitizeProjectResponse clips owner to { id }');
  assert(/project\.team\.map\([\s\S]{0,80}\{\s*id:/.test(body),
    'sanitizeProjectResponse maps team to [{ id }, ...]');
}

out('\n=== C. PROJECT_LIST_POPULATE shape ===');

// C1. owner + team allow-listed; orders + files scoped
{
  const m = PROJECT.match(/const PROJECT_LIST_POPULATE\s*=\s*\{([\s\S]*?)\};/);
  const body = m ? m[1] : '';
  assert(/owner:\s*\{\s*fields:\s*PROJECT_USER_FIELDS\s*\}/.test(body),
    'PROJECT_LIST_POPULATE.owner uses PROJECT_USER_FIELDS');
  assert(/team:\s*\{\s*fields:\s*PROJECT_USER_FIELDS\s*\}/.test(body),
    'PROJECT_LIST_POPULATE.team uses PROJECT_USER_FIELDS');
  assert(/orders:\s*\{\s*fields:\s*\[\s*['"]id['"]\s*,\s*['"]orderStatus['"]/.test(body),
    'PROJECT_LIST_POPULATE.orders is allow-listed (no order PII)');
  assert(/files:\s*\{\s*fields:/.test(body),
    'PROJECT_LIST_POPULATE.files is allow-listed');
}

out('\n=== D. Schema conformance for PROJECT_PUBLIC_FIELDS ===');

// Same class as the balanceAfter / publishedAt incident — every name
// must exist on the project schema OR be a Strapi 5 auto-attribute.
{
  const schema = require('/var/www/serpbays/serpbays_server/src/api/project/content-types/project/schema.json');
  const schemaAttrs = validQueryAttrs(schema);
  const m = PROJECT.match(/const PROJECT_PUBLIC_FIELDS\s*=\s*\[([\s\S]*?)\]/);
  const declared = m
    ? Array.from(stripJsComments(m[1]).matchAll(/['"]([^'"]+)['"]/g)).map(x => x[1])
    : [];
  const bogus = declared.filter(k => !schemaAttrs.has(k));
  assert(bogus.length === 0,
    `PROJECT_PUBLIC_FIELDS contains only real schema attributes (bogus: [${bogus.join(', ')}])`);
  // Make sure the test would catch a regression
  assert(declared.length > 5,
    'PROJECT_PUBLIC_FIELDS has the expected breadth of attributes');
}

out('\n=== E. Other response paths sanitize ===');

// E1. createFromTemplate sanitizes return
{
  const fn = PROJECT.match(/async createFromTemplate\(ctx\)[\s\S]*?^\s\s\},/m);
  const body = fn ? fn[0] : '';
  assert(/data:\s*sanitizeProjectResponse\(/.test(body),
    'createFromTemplate response is sanitized');
}

// E2. addTeamMembers sanitizes return
{
  const fn = PROJECT.match(/async addTeamMembers\(ctx\)[\s\S]*?^\s\s\},/m);
  const body = fn ? fn[0] : '';
  assert(/data:\s*sanitizeProjectResponse\(/.test(body),
    'addTeamMembers response is sanitized');
}

out('\n=== F. Audit — all 14 broad populates converted ===');

// F1. All populate sites in project.js now use either the named constant
// or an explicit allow-list. Anything bare ('owner', 'team') is a regression.
{
  const lines = PROJECT.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.trim().startsWith('//')) continue;
    if (/populate:\s*\[/.test(L) && /['"](owner|team)['"]/.test(L)) {
      offenders.push(`line ${i+1}: ${L.trim()}`);
    }
  }
  assert(offenders.length === 0,
    `no bare populate: ['owner','team'] forms remain (offenders: ${offenders.length ? '\n    ' + offenders.join('\n    ') : 'none'})`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
