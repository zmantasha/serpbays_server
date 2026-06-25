#!/usr/bin/env node
/**
 * Audit every entityService / db.query find* call across the codebase for
 * `fields: [...]` arrays that reference attributes NOT on the target
 * content type's schema.
 *
 * Strapi 4 silently ignored unknown keys; Strapi 5 throws
 * `ValidationError: Invalid key <name>` and 400s the request. This is the
 * same bug class that broke /api/orders/:id after the
 * placementSpeed → assignedDate → totalPrice → platformFee chain.
 *
 * Coverage:
 *   - TOP-LEVEL fields[]: validated against the OUTER content type
 *   - NESTED populate.X.fields[]: validated against X's TARGET content type
 *     (resolved via the outer schema's relations map). Arbitrarily deep
 *     populate trees are walked recursively.
 *
 * Skipped (out of scope — different field rules apply):
 *   - components / dynamiczone (lives in src/components/, not src/api)
 *   - media relations (Strapi file attributes: url/hash/ext/etc.)
 *   - Unknown relation targets (logged as "unresolved" — manual review)
 *
 * Approach:
 *   1. Load every schema.json. For each content type, build BOTH
 *      `attributes` (Set<string>) AND `relations` (Map<attrName, targetUid>).
 *   2. For each .js file, find every entityService.findOne|findMany|findFirst|findPage
 *      and db.query(...).findOne|findMany|findFirst call.
 *   3. Walk the options object with brace-depth tracking. Recursively walk
 *      any populate: { X: { fields/populate: ... } } subtree; at each
 *      depth, validate fields[] against the resolved target content type.
 *
 * Run: cd serpbays_server && node scripts/audit-bogus-fields.js
 *
 * Exit 0 if zero bogus keys, 1 otherwise.
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');

const fs = require('fs');
const path = require('path');

// Strapi adds these attributes to every content type implicitly.
const STRAPI_IMPLICIT = new Set([
  'id', 'documentId',
  'createdAt', 'updatedAt', 'publishedAt',
  'createdBy', 'updatedBy',
  'locale', 'localizations',
]);

// ─── Step 1: build attribute + relation maps ──────────────────────────
const ATTRS = {};      // uid → Set<attribute>
const RELATIONS = {};  // uid → Map<attrName, targetUid>

function loadSchema(uid, schemaPath, extraAttrs = []) {
  if (!fs.existsSync(schemaPath)) return;
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch {
    return;
  }
  const attributes = schema.attributes || {};
  ATTRS[uid] = new Set([...Object.keys(attributes), ...STRAPI_IMPLICIT, ...extraAttrs]);
  const rels = new Map();
  for (const [name, def] of Object.entries(attributes)) {
    if (!def || typeof def !== 'object') continue;
    if (def.type === 'relation' && typeof def.target === 'string') {
      rels.set(name, def.target);
    } else if (def.type === 'media') {
      // Media attributes always resolve to the upload-plugin file content
      // type, regardless of allowedTypes (images/videos/files).
      rels.set(name, 'plugin::upload.file');
    }
    // Components and dynamiczone left out — they have a separate schema
    // tree under src/components/ that's out of scope for this audit.
  }
  RELATIONS[uid] = rels;
}

(function loadAllSchemas() {
  const apiRoot = path.join('src', 'api');
  if (fs.existsSync(apiRoot)) {
    for (const resource of fs.readdirSync(apiRoot)) {
      const ctDir = path.join(apiRoot, resource, 'content-types');
      if (!fs.existsSync(ctDir)) continue;
      for (const ct of fs.readdirSync(ctDir)) {
        loadSchema(`api::${resource}.${ct}`, path.join(ctDir, ct, 'schema.json'));
      }
    }
  }
  loadSchema(
    'plugin::users-permissions.user',
    path.join('src', 'extensions', 'users-permissions', 'content-types', 'user', 'schema.json'),
    ['username', 'email', 'provider', 'password', 'resetPasswordToken',
     'confirmationToken', 'confirmed', 'blocked', 'role'],
  );
  // users-permissions role — plugin built-in (no on-disk schema)
  ATTRS['plugin::users-permissions.role'] = new Set([
    'id', 'documentId', 'createdAt', 'updatedAt',
    'name', 'description', 'type', 'permissions', 'users',
  ]);
  RELATIONS['plugin::users-permissions.role'] = new Map();
  // upload file — plugin built-in
  ATTRS['plugin::upload.file'] = new Set([
    'id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt',
    'name', 'alternativeText', 'caption', 'width', 'height', 'formats',
    'hash', 'ext', 'mime', 'size', 'url', 'previewUrl', 'provider',
    'provider_metadata', 'related', 'folder', 'folderPath',
  ]);
  RELATIONS['plugin::upload.file'] = new Map();
})();

// ─── Step 2: parsing helpers (brace-depth aware) ──────────────────────

function skipPastChar(text, i, len) {
  // Walks past strings / line comments / block comments. Returns the new
  // index, or null if `text[i]` doesn't open one of those. Caller advances
  // by 1 if null is returned.
  const c = text[i];
  if (c === '"' || c === "'" || c === '`') {
    const quote = c;
    i++;
    while (i < len && text[i] !== quote) {
      if (text[i] === '\\') { i += 2; continue; }
      if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
        i += 2;
        let td = 1;
        while (i < len && td > 0) {
          if (text[i] === '{') td++;
          else if (text[i] === '}') td--;
          i++;
        }
        continue;
      }
      i++;
    }
    return i + 1;
  }
  if (c === '/' && text[i + 1] === '/') {
    while (i < len && text[i] !== '\n') i++;
    return i;
  }
  if (c === '/' && text[i + 1] === '*') {
    i += 2;
    while (i < len && !(text[i] === '*' && text[i + 1] === '/')) i++;
    return i + 2;
  }
  return null;
}

function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 1;
  let i = openIndex + 1;
  const len = text.length;
  while (i < len && depth > 0) {
    const skipped = skipPastChar(text, i, len);
    if (skipped !== null) { i = skipped; continue; }
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

const findMatchingBrace = (text, i) => findMatching(text, i, '{', '}');
const findMatchingBracket = (text, i) => findMatching(text, i, '[', ']');
const findMatchingParen = (text, i) => findMatching(text, i, '(', ')');

function extractKeysFromArrayLiteral(text, openBracket, closeBracket) {
  const body = text.slice(openBracket + 1, closeBracket);
  const stripped = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const matches = stripped.match(/['"][a-zA-Z_][a-zA-Z0-9_]*['"]/g) || [];
  return matches.map(s => s.slice(1, -1));
}

// Inside an options object's body [open, close], find each top-level
// property at name `name`. Returns array of (valueStart, valueEnd) pairs
// — the value can be a literal, `{...}` block, `[...]` array, etc.
// We only look at depth 1 (immediately inside the options object).
function findTopLevelPropertyValues(text, open, close, name) {
  const results = [];
  let i = open + 1;
  while (i < close) {
    const skipped = skipPastChar(text, i, text.length);
    if (skipped !== null) { i = skipped; continue; }
    const c = text[i];
    if (c === '{') {
      const end = findMatchingBrace(text, i);
      if (end > 0) { i = end + 1; continue; }
    }
    if (c === '[') {
      const end = findMatchingBracket(text, i);
      if (end > 0) { i = end + 1; continue; }
    }
    // Check for `<name>:` at depth-1
    if (text.slice(i, i + name.length + 1) === `${name}:`) {
      let j = i + name.length + 1;
      while (j < close && /\s/.test(text[j])) j++;
      // Determine value end based on opening char
      if (text[j] === '[' || text[j] === '{' || text[j] === '(') {
        const closers = { '[': ']', '{': '}', '(': ')' };
        const end = findMatching(text, j, text[j], closers[text[j]]);
        if (end > 0) { results.push([j, end]); i = end + 1; continue; }
      } else if (text[j] === "'" || text[j] === '"' || text[j] === '`') {
        const s = skipPastChar(text, j, text.length);
        results.push([j, s - 1]);
        i = s;
        continue;
      } else {
        // boolean / number / undefined / identifier — value ends at next , or }
        let k = j;
        while (k < close && text[k] !== ',' && text[k] !== '}' && text[k] !== '\n') k++;
        results.push([j, k - 1]);
        i = k;
        continue;
      }
    }
    i++;
  }
  return results;
}

// Inside `populate: { ... }` value, enumerate each top-level relation key
// and return [(name, valueStart, valueEnd)] for those whose value is `{`.
// (Other shapes — bare booleans, simple object refs, primitives — don't
// have fields[] to validate.)
function enumeratePopulateRelations(text, populateOpen, populateClose) {
  const results = [];
  let i = populateOpen + 1;
  while (i < populateClose) {
    const skipped = skipPastChar(text, i, text.length);
    if (skipped !== null) { i = skipped; continue; }
    const c = text[i];
    if (c === '{') {
      const end = findMatchingBrace(text, i);
      if (end > 0) { i = end + 1; continue; }
    }
    if (c === '[') {
      const end = findMatchingBracket(text, i);
      if (end > 0) { i = end + 1; continue; }
    }
    // Look for `name:` at depth-1 or `'name':` / `"name":`
    let nameMatch = null;
    if (text[i] === "'" || text[i] === '"') {
      const quote = text[i];
      let q = i + 1;
      while (q < populateClose && text[q] !== quote) q++;
      const candidate = text.slice(i + 1, q);
      // expect immediately after closing quote: optional space + `:`
      let after = q + 1;
      while (after < populateClose && /\s/.test(text[after])) after++;
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate) && text[after] === ':') {
        nameMatch = { name: candidate, afterColon: after + 1 };
      }
    } else if (/[a-zA-Z_]/.test(text[i])) {
      let q = i;
      while (q < populateClose && /[a-zA-Z0-9_]/.test(text[q])) q++;
      const candidate = text.slice(i, q);
      let after = q;
      while (after < populateClose && /\s/.test(text[after])) after++;
      if (text[after] === ':' && candidate) {
        nameMatch = { name: candidate, afterColon: after + 1 };
      }
    }
    if (nameMatch) {
      let j = nameMatch.afterColon;
      while (j < populateClose && /\s/.test(text[j])) j++;
      if (text[j] === '{') {
        const end = findMatchingBrace(text, j);
        if (end > 0) {
          results.push({ name: nameMatch.name, open: j, close: end });
          i = end + 1;
          continue;
        }
      } else {
        // primitive / bare ref / true/false — no fields to validate
        let k = j;
        while (k < populateClose && text[k] !== ',' && text[k] !== '}' && text[k] !== '\n') k++;
        i = k;
        continue;
      }
    }
    i++;
  }
  return results;
}

// ─── Step 3: per-call walker ──────────────────────────────────────────

const REPORTS = []; // { file, line, uid, depth, scope, keys, bogus, note? }

function validateOptionsObject(text, optionsOpen, optionsClose, currentUid, file, lineNo, scope) {
  // 1) Validate top-level fields[] against currentUid
  const fieldsValues = findTopLevelPropertyValues(text, optionsOpen, optionsClose, 'fields');
  for (const [start, end] of fieldsValues) {
    if (text[start] !== '[') continue;
    const keys = extractKeysFromArrayLiteral(text, start, end);
    if (keys.length === 0) continue;
    const attrs = ATTRS[currentUid];
    if (!attrs) {
      REPORTS.push({ file, line: lineNo, uid: currentUid, scope, keys, bogus: [], note: 'schema not loaded' });
      continue;
    }
    const bogus = keys.filter(k => !attrs.has(k));
    if (bogus.length > 0) {
      REPORTS.push({ file, line: lineNo, uid: currentUid, scope, keys, bogus });
    }
  }

  // 2) Recurse into populate: { X: { ... } } — resolve X via relations map
  const populateValues = findTopLevelPropertyValues(text, optionsOpen, optionsClose, 'populate');
  for (const [start, end] of populateValues) {
    if (text[start] !== '{') continue;
    const relations = RELATIONS[currentUid] || new Map();
    const subEntries = enumeratePopulateRelations(text, start, end);
    for (const { name, open, close } of subEntries) {
      const targetUid = relations.get(name);
      if (!targetUid) {
        // Could be a component, dynamiczone, media (resolved via different
        // metadata), OR an attribute that doesn't exist on the outer
        // schema (which is itself a bug — populating a non-existent
        // relation). Strapi 5 may or may not throw on this depending on
        // the call path; flag for manual review with a soft warning.
        REPORTS.push({
          file, line: lineNo, uid: currentUid, scope: `${scope} > populate.${name}`,
          keys: [], bogus: [], note: 'unresolved populate target (component/media/unknown)',
        });
        continue;
      }
      validateOptionsObject(text, open, close, targetUid, file, lineNo, `${scope} > populate.${name}`);
    }
  }
}

const FIND_CALL = /(?:strapi\.)?(?:entityService\.(?:findOne|findMany|findFirst|findPage)|db\.query\(\s*['"]((?:api|plugin)::[a-zA-Z\-_.]+)['"]\s*\)\.(?:findOne|findMany|findFirst))/g;

function scanFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  let m;
  FIND_CALL.lastIndex = 0;
  while ((m = FIND_CALL.exec(text)) !== null) {
    const matchEnd = m.index + m[0].length;
    let p = matchEnd;
    while (p < text.length && text[p] !== '(') p++;
    if (p >= text.length) continue;
    const closeParen = findMatchingParen(text, p);
    if (closeParen < 0) continue;

    // Resolve content type uid
    let uid;
    if (m[1]) {
      uid = m[1];
    } else {
      const firstArg = text.slice(p + 1, closeParen).match(/['"]((?:api|plugin)::[a-zA-Z\-_.]+)['"]/);
      uid = firstArg ? firstArg[1] : null;
    }
    if (!uid) continue;

    // Find the last `{ ... }` at paren-depth 1 = the options object.
    let i = p + 1;
    let lastOptions = null;
    while (i < closeParen) {
      const skipped = skipPastChar(text, i, text.length);
      if (skipped !== null) { i = skipped; continue; }
      if (text[i] === '{') {
        const end = findMatchingBrace(text, i);
        if (end > 0 && end < closeParen) { lastOptions = [i, end]; i = end + 1; continue; }
      }
      i++;
    }
    if (!lastOptions) continue;

    const lineNo = text.slice(0, m.index).split('\n').length;
    validateOptionsObject(text, lastOptions[0], lastOptions[1], uid, filePath, lineNo, uid);
  }
}

function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkDir(full);
      continue;
    }
    if (!entry.name.endsWith('.js') || entry.name.endsWith('.disabled')) continue;
    try { scanFile(full); } catch (err) { console.warn(`[scan-error] ${full}: ${err.message}`); }
  }
}

walkDir('src');

// ─── Step 4: report ───────────────────────────────────────────────────

const bogus = REPORTS.filter(r => r.bogus && r.bogus.length > 0);
const notes = REPORTS.filter(r => r.note && !r.bogus.length);

console.log(`Scanned ${Object.keys(ATTRS).length} content type schemas + relation maps.`);
console.log(`Found ${bogus.length} call site(s) with bogus fields[] keys.`);
console.log(`Found ${notes.length} unresolved populate target(s) (component/media/unknown — manual review).`);

if (bogus.length === 0) {
  console.log('\n✅ No bogus fields[] keys found (top-level OR nested).');
}

for (const r of bogus) {
  console.log(`\n${r.file}:${r.line}`);
  console.log(`  scope:       ${r.scope}`);
  console.log(`  contentType: ${r.uid}`);
  console.log(`  fields:      [${r.keys.join(', ')}]`);
  console.log(`  ❌ bogus:    [${r.bogus.join(', ')}]`);
}

// Print unresolved populate targets ONLY if --verbose is passed, OR if
// caller wants the full picture. They're noisy (lots of legit components +
// media populates that aren't bugs).
if (process.argv.includes('--verbose')) {
  if (notes.length) console.log('\n--- unresolved populate targets ---');
  for (const r of notes) {
    console.log(`${r.file}:${r.line}  scope=${r.scope}`);
  }
}

process.exit(bogus.length === 0 ? 0 : 1);
