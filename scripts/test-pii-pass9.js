#!/usr/bin/env node
/**
 * Regression test — PII pass 9 (projects + orders + nested children).
 *
 * Locks in every ownership / field-allow-list / IDOR defense across:
 *   - Project       (api::project.project)
 *   - Order         (api::order.order)
 *   - OrderContent  (nested under order)
 *   - OutsourcedContent (nested under order)
 *   - Communication (nested under order)
 *   - PublisherWebsite (api::publisher-website.publisher-website)
 *
 * If any assertion fails, a cross-user data leak is live or has been
 * re-introduced. Static-grep only — runs offline against the source tree.
 *
 * Run: cd serpbays_server && node scripts/test-pii-pass9.js
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

const PROJECT = read('src/api/project/controllers/project.js');
const ORDER   = read('src/api/order/controllers/order.js');
const ORDER_RT_DEFAULT = read('src/api/order/routes/order.js');
const ORDER_RT_CUSTOM  = read('src/api/order/routes/custom-order.js');
const ORDER_CONTENT = read('src/api/order-content/controllers/order-content.js');
const OUTSOURCED    = read('src/api/outsourced-content/controllers/outsourced-content.js');
const COMM          = read('src/api/communication/controllers/communication.js');
const PUB_WEBSITE   = read('src/api/publisher-website/controllers/publisher-website.js');
const ORDER_SCHEMA  = read('src/api/order/content-types/order/schema.json');
const PROJ_SCHEMA   = read('src/api/project/content-types/project/schema.json');

out('\n=== A. Project controller — ownership + field allow-list ===');

// find/findOne/getMyProjects must take ctx.state.user before any DB read.
// Accept either `ctx.state.user` or destructured `{ user } = ctx.state`.
{
  for (const handler of ['async find', 'async findOne', 'async getMyProjects']) {
    const idx = PROJECT.indexOf(handler + '(ctx)');
    assert(idx >= 0, `project controller defines ${handler.replace('async ', '')}`);
    const window = idx >= 0 ? PROJECT.slice(idx, idx + 4000) : '';
    const next = window.search(/\n\s*async\s+\w+\s*\(ctx\)/);
    const body = next > 100 ? window.slice(0, next) : window;
    assert(/ctx\.state\.user|\{\s*user\s*\}\s*=\s*ctx\.state/.test(body),
      `project ${handler.replace('async ', '')} reads ctx.state user`);
  }
}

// find override must filter by owner OR team membership — without this,
// the default core controller's find returns every project on the platform.
{
  const m = PROJECT.match(/async find\(ctx\)[\s\S]{0,2500}/);
  const body = m ? m[0] : '';
  assert(/\{\s*owner:\s*user\.id\s*\}/.test(body),
    'project find ownership clause includes { owner: user.id }');
  assert(/\{\s*team:\s*\{\s*id:\s*user\.id/.test(body),
    'project find ownership clause includes { team: { id: user.id } }');
  assert(/populate:\s*PROJECT_LIST_POPULATE/.test(body),
    'project find sets populate: PROJECT_LIST_POPULATE (allow-list)');
  assert(/pageSize[\s\S]{0,300}>\s*100/.test(body),
    'project find caps pageSize > 100');
  assert(/sanitizeProjectResponse/.test(body),
    'project find sanitizes rows before returning');
}

// PROJECT_USER_FIELDS allow-list exists and is used (no broad user populate).
assert(/PROJECT_USER_FIELDS/.test(PROJECT),
  'project controller defines PROJECT_USER_FIELDS allow-list');
assert(/PROJECT_LIST_POPULATE\s*=\s*\{[\s\S]{0,400}owner:\s*\{\s*fields:\s*PROJECT_USER_FIELDS/.test(PROJECT),
  'project list populate uses owner field allow-list');
assert(/PROJECT_LIST_POPULATE\s*=\s*\{[\s\S]{0,400}team:\s*\{\s*fields:\s*PROJECT_USER_FIELDS/.test(PROJECT),
  'project list populate uses team field allow-list');

// sanitizeProjectResponse exists and reduces owner/team to {id}.
assert(/function\s+sanitizeProjectResponse\s*\([\s\S]{0,500}owner\s*=\s*\{\s*id/.test(PROJECT),
  'sanitizeProjectResponse strips owner to { id }');

// getMyProjects: filter on owner OR team membership (not all-of-tenant).
assert(/getMyProjects[\s\S]{0,1000}\{\s*owner:\s*user\.id\s*\}[\s\S]{0,300}\{\s*team:\s*\{\s*id:\s*user\.id/.test(PROJECT),
  'getMyProjects filters by owner OR team membership');

// findOne enforces ownership before responding.
assert(/findOne[\s\S]{0,800}entity\.owner\.id\s*===\s*user\.id/.test(PROJECT),
  'project findOne checks entity.owner.id === user.id');

// No `populate: '*'` anywhere in the project controller.
assert(!/populate:\s*['"]?\*['"]?/.test(PROJECT.replace(/\/\/[^\n]*/g, '')),
  'project controller does not use populate: "*" (excluding comments)');

out('\n=== B. Order controller — ownership + allow-list + sanitizer ===');

// ORDER_PUBLIC_FIELDS, ORDER_FETCH_FIELDS, ORDER_LIST_POPULATE, ORDER_SNAPSHOT_PUBLISHER_PRIVATE all defined.
assert(/ORDER_PUBLIC_FIELDS/.test(ORDER),       'order ORDER_PUBLIC_FIELDS allow-list defined');
assert(/ORDER_FETCH_FIELDS/.test(ORDER),        'order ORDER_FETCH_FIELDS defined');
assert(/ORDER_LIST_POPULATE/.test(ORDER),       'order ORDER_LIST_POPULATE defined');
assert(/ORDER_SNAPSHOT_PUBLISHER_PRIVATE/.test(ORDER),
  'order ORDER_SNAPSHOT_PUBLISHER_PRIVATE defined (snapshot publisher fields)');

// Snapshot publisher fields include all three sensitive snapshots.
{
  const m = ORDER.match(/ORDER_SNAPSHOT_PUBLISHER_PRIVATE\s*=\s*\[([\s\S]*?)\]/);
  const body = m ? m[1] : '';
  assert(/websitePublisherEmail/.test(body), 'snapshot list strips websitePublisherEmail');
  assert(/websitePublisherName/.test(body),  'snapshot list strips websitePublisherName');
  assert(/websitePublisherPrice/.test(body), 'snapshot list strips websitePublisherPrice');
}

// ORDER_LIST_POPULATE: advertiser/publisher are id-only.
assert(/ORDER_LIST_POPULATE\s*=\s*\{[\s\S]{0,800}advertiser:\s*\{\s*fields:\s*\['id'\]/.test(ORDER),
  'ORDER_LIST_POPULATE: advertiser populate = { fields: [id] }');
assert(/ORDER_LIST_POPULATE\s*=\s*\{[\s\S]{0,800}publisher:\s*\{\s*fields:\s*\['id'\]/.test(ORDER),
  'ORDER_LIST_POPULATE: publisher populate = { fields: [id] }');

// buildOrderOwnershipFilter exists with all 3 ownership clauses.
{
  const m = ORDER.match(/function\s+buildOrderOwnershipFilter\s*\(user\)[\s\S]*?\n  \}/);
  const body = m ? m[0] : '';
  assert(/advertiser:\s*user\.id/.test(body),
    'buildOrderOwnershipFilter includes { advertiser: user.id }');
  assert(/publisher:\s*user\.id/.test(body),
    'buildOrderOwnershipFilter includes { publisher: user.id }');
  assert(/websitePublisherEmail:\s*user\.email/.test(body),
    'buildOrderOwnershipFilter includes { websitePublisherEmail: user.email } (legacy)');
}

// find/findOne: auth check + ownership filter + ctx.query overwrite.
{
  const find = ORDER.match(/async find\(ctx\)[\s\S]*?(?=\n    async \w|\n  \}\);)/);
  const body = find ? find[0] : '';
  assert(/ctx\.state\.user/.test(body),                     'order find requires ctx.state.user');
  assert(/buildOrderOwnershipFilter/.test(body),            'order find calls buildOrderOwnershipFilter');
  assert(/ctx\.query\s*=\s*\{[\s\S]{0,200}filters:/.test(body),
    'order find overwrites ctx.query with explicit filters');
  assert(/fields:\s*ORDER_FETCH_FIELDS/.test(body),         'order find sets fields: ORDER_FETCH_FIELDS');
  assert(/populate:\s*ORDER_LIST_POPULATE/.test(body),      'order find sets populate: ORDER_LIST_POPULATE');
  assert(/sanitizeOrderResponse/.test(body),                'order find sanitizes rows before returning');
  // pageSize cap defense — windowed match (real code: assigns to ps then `ps > 100`).
  assert(/pageSize[\s\S]{0,300}>\s*100/.test(body),         'order find caps pageSize > 100');
}

{
  const findOne = ORDER.match(/async findOne\(ctx\)[\s\S]*?(?=\n    async \w|\n  \}\);)/);
  const body = findOne ? findOne[0] : '';
  assert(/ctx\.state\.user/.test(body),                     'order findOne requires ctx.state.user');
  assert(/isAdvertiser[\s\S]{0,100}order\.advertiser\?\.id\s*===\s*ctx\.state\.user\.id/.test(body),
    'order findOne computes isAdvertiser flag');
  assert(/isPublisherFK[\s\S]{0,200}order\.publisher\?\.id\s*===\s*ctx\.state\.user\.id/.test(body),
    'order findOne computes isPublisherFK flag');
  assert(/sanitizeOrderResponse/.test(body),
    'order findOne sanitizes before returning');
}

// sanitizeOrderResponse: drops snapshot fields + reduces advertiser/publisher to {id}.
{
  const m = ORDER.match(/function\s+sanitizeOrderResponse\s*\(order\)[\s\S]*?\n\}/);
  const body = m ? m[0] : '';
  assert(/stripOrderForResponse/.test(body),
    'sanitizeOrderResponse calls stripOrderForResponse (snapshot strip)');
  assert(/order\.advertiser\s*=\s*\{\s*id:\s*order\.advertiser\.id\s*\}/.test(body),
    'sanitizeOrderResponse reduces order.advertiser to { id }');
  assert(/order\.publisher\s*=\s*\{\s*id:\s*order\.publisher\.id\s*\}/.test(body),
    'sanitizeOrderResponse reduces order.publisher to { id }');
  // Website allow-list applied to nested website
  assert(/WEBSITE_PUBLIC_FIELD_SET\.has/.test(body),
    'sanitizeOrderResponse intersects order.website with WEBSITE_PUBLIC_FIELDS');
}

// No populate: '*' in order controller.
assert(!/populate:\s*['"]?\*['"]?/.test(ORDER.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  'order controller has no populate: "*" (excluding comments)');

out('\n=== C. Nested children (order-content / outsourced / communication) ===');

for (const [name, src] of [
  ['order-content',   ORDER_CONTENT],
  ['outsourced',      OUTSOURCED],
  ['communication',   COMM],
]) {
  const find = src.match(/async find\(ctx\)[\s\S]*?(?=\n  async \w|\n\}\)\);)/);
  const body = find ? find[0] : '';
  assert(/ctx\.state\.user/.test(body),
    `${name} find requires ctx.state.user`);
  // Ownership filter joins to the parent order's advertiser/publisher
  assert(/order:\s*\{\s*advertiser/.test(body) || /order:\s*\{\s*publisher/.test(body) || /buildOwnership|buildCommOwnership/.test(body),
    `${name} find filters by parent-order advertiser/publisher`);
  assert(/ctx\.query\s*=\s*\{[\s\S]{0,200}filters:/.test(body),
    `${name} find overwrites ctx.query with ownership filters`);

  const findOne = src.match(/async findOne\(ctx\)[\s\S]*?(?=\n  async \w|\n\}\)\);)/);
  const fobody = findOne ? findOne[0] : '';
  assert(/ctx\.state\.user/.test(fobody),
    `${name} findOne requires ctx.state.user`);
}

// order-content + outsourced: no caller populate leak
assert(/populate:\s*undefined/.test(ORDER_CONTENT),
  'order-content find sets populate: undefined (no caller populate)');
assert(/populate:\s*undefined/.test(OUTSOURCED),
  'outsourced find sets populate: undefined (no caller populate)');

out('\n=== D. Publisher-website controller — strict ownership ===');

// Find handler exists and enforces strict ownership (currentPublisherId,
// with the email leg gated on no FK yet existing — preventing email-collision
// takeover of a website that already has an FK owner).
assert(/Strict ownership filter — finding #5 fix/.test(PUB_WEBSITE),
  'publisher-website has the "strict ownership" comment marker');
assert(/currentPublisherId/.test(PUB_WEBSITE),
  'publisher-website ownership uses currentPublisherId relation');
// No bare `publisher: user.email` allowed without strict-mode gating
{
  // Approve-style admin endpoints DO use email matching but only after admin auth.
  // The user-facing find/findOne path uses currentPublisherId.
  const findFn = PUB_WEBSITE.match(/async find\(ctx\)[\s\S]*?(?=\n  async \w|\n\}\)\);)/);
  if (findFn) {
    assert(/currentPublisherId/.test(findFn[0]),
      'publisher-website find filters by currentPublisherId');
  }
}

out('\n=== E. Schema sanity — sensitive snapshot fields exist on order schema ===');

// These fields exist on the schema (so the strip in the controller is meaningful).
// If a future migration removes them, the strip becomes a no-op but the assertion
// here warns us.
const schema = (() => { try { return JSON.parse(ORDER_SCHEMA); } catch { return {}; } })();
const attrs = (schema && schema.attributes) || {};
assert('websitePublisherEmail' in attrs,
  'order schema still has websitePublisherEmail (so strip is meaningful)');
assert('websitePublisherName' in attrs,
  'order schema still has websitePublisherName');
assert('websitePublisherPrice' in attrs,
  'order schema still has websitePublisherPrice');

out('\n=== F. No caller-controlled populate spread (find handlers only) ===');

// Spreading ...ctx.query is OK *as long as* the spread is followed by explicit
// `populate:` / `fields:` / `filters:` overrides. Manually verified the 4 spots
// that spread ctx.query do exactly that. Codify the override pattern.
const SPREAD_FILES = [
  ['order',            ORDER],
  ['order-content',    ORDER_CONTENT],
  ['outsourced',       OUTSOURCED],
  ['communication',    COMM],
];
for (const [name, src] of SPREAD_FILES) {
  // For every `...ctx.query` spread, the same object literal must override
  // `filters` AND (`populate` OR `fields`). Scan a 600-char window after
  // each spread — that's enough to span the full `ctx.query = { ...ctx.query,
  // filters: ..., fields: ..., populate: ... };` assignment in every file
  // we audit, without bleeding into the next statement.
  const re = /\.\.\.ctx\.query([\s\S]{0,600})/g;
  let m;
  let allOk = true;
  while ((m = re.exec(src)) !== null) {
    const chunk = m[1];
    if (!(/filters:/.test(chunk) && (/populate:/.test(chunk) || /fields:/.test(chunk)))) {
      allOk = false;
      break;
    }
  }
  assert(allOk, `${name} spreads ctx.query only when paired with explicit filters + populate/fields overrides`);
}

out('\n=== G. Default core router for orders is overridden in the controller ===');

// orders/routes/order.js uses createCoreRouter — without controller overrides,
// the default Strapi find/findOne would skip ownership. Confirm overrides exist
// (covered in Section B, but also confirm via routes file shape).
assert(/createCoreRouter\(\s*['"]api::order\.order['"]/.test(ORDER_RT_DEFAULT),
  'order default route uses createCoreRouter');
assert(/async find\(ctx\)/.test(ORDER) && /async findOne\(ctx\)/.test(ORDER),
  'order controller overrides find + findOne');
// And delete/update are not exposed via the default route in a vulnerable form —
// they should be hardened in the controller or removed. Just check that the
// controller exists for these defaults.
assert(/createCoreController/.test(ORDER),
  'order controller is built via createCoreController (so overrides take effect)');

out('\n=== H. getMyOrders / getAvailableOrders custom routes are ownership-gated ===');

// Custom orders/my-orders + orders/available are auth-only by default; the
// real ownership filter is in the controller. Make sure the handlers exist
// and reference advertiser/publisher.
for (const handler of ['async getMyOrders', 'async getAvailableOrders']) {
  const m = ORDER.match(new RegExp(handler + '\\s*\\(ctx\\)[\\s\\S]*?(?=\\n    async \\w|\\n  \\}\\);)'));
  const body = m ? m[0] : '';
  assert(body.length > 0, `order controller defines ${handler.replace('async ', '')}`);
  if (body) {
    assert(/ctx\.state\.user/.test(body),
      `${handler.replace('async ', '')} requires ctx.state.user`);
    assert(/advertiser|publisher/.test(body),
      `${handler.replace('async ', '')} references advertiser/publisher ownership`);
  }
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
