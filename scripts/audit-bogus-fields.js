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
 * The challenge: many call sites have BOTH a top-level `fields:` array
 * (validated against the outer content type) AND nested `populate.X.fields:`
 * arrays (validated against X's content type). They look identical in raw
 * text; brace-depth tracking is required to distinguish them.
 *
 * Approach:
 *   1. Load every schema.json → contentTypeUid → Set<attribute>.
 *   2. For each .js file, find every `entityService.findOne|findMany|findFirst`
 *      or `db.query(...).findOne|findMany|findFirst` call.
 *   3. Parse the options object: walk character-by-character tracking brace
 *      depth, and identify the TOP-LEVEL `fields: [...]` (depth 1 inside
 *      the options object) vs nested ones inside `populate: { ... }`.
 *   4. Validate the top-level keys against the schema.
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

// ─── Step 1: build attribute map ──────────────────────────────────────
const SCHEMAS = {};

function loadSchemaFile(uid, schemaPath, extraAttrs = []) {
  if (!fs.existsSync(schemaPath)) return;
  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    SCHEMAS[uid] = new Set([
      ...Object.keys(schema.attributes || {}),
      ...STRAPI_IMPLICIT,
      ...extraAttrs,
    ]);
  } catch {}
}

(function loadSchemas() {
  const apiRoot = path.join('src', 'api');
  if (fs.existsSync(apiRoot)) {
    for (const resource of fs.readdirSync(apiRoot)) {
      const ctDir = path.join(apiRoot, resource, 'content-types');
      if (!fs.existsSync(ctDir)) continue;
      for (const ct of fs.readdirSync(ctDir)) {
        loadSchemaFile(`api::${resource}.${ct}`, path.join(ctDir, ct, 'schema.json'));
      }
    }
  }
  // users-permissions user lives in extensions
  loadSchemaFile(
    'plugin::users-permissions.user',
    path.join('src', 'extensions', 'users-permissions', 'content-types', 'user', 'schema.json'),
    ['username', 'email', 'provider', 'password', 'resetPasswordToken',
     'confirmationToken', 'confirmed', 'blocked', 'role'],
  );
  // users-permissions role — standard plugin attributes (no on-disk schema).
  SCHEMAS['plugin::users-permissions.role'] = new Set([
    'id', 'documentId', 'createdAt', 'updatedAt',
    'name', 'description', 'type', 'permissions', 'users',
  ]);
})();

// ─── Step 2: parse JS files with brace-depth tracking ─────────────────

const FIND_CALL = /(?:strapi\.)?(?:entityService\.(?:findOne|findMany|findFirst|findPage)|db\.query\(\s*['"]((?:api|plugin)::[a-zA-Z\-_.]+)['"]\s*\)\.(?:findOne|findMany|findFirst))/g;
// Two flavors:
//   strapi.entityService.findOne('api::x.y', id, { ... })
//   strapi.db.query('api::x.y').findOne({ ... })

const REPORTS = [];

function findMatchingBrace(text, openIndex) {
  // openIndex points at `{`. Return index of matching `}`. Handles strings,
  // single-line + multi-line comments, escaped chars.
  let depth = 1;
  let i = openIndex + 1;
  const len = text.length;
  while (i < len && depth > 0) {
    const c = text[i];
    // Skip strings
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < len && text[i] !== quote) {
        if (text[i] === '\\') { i += 2; continue; }
        if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          // template literal — skip the expression by walking braces
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
      i++;
      continue;
    }
    // Skip // line comments
    if (c === '/' && text[i + 1] === '/') {
      while (i < len && text[i] !== '\n') i++;
      continue;
    }
    // Skip /* block */ comments
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

function findArgListClose(text, openParenIndex) {
  // Same idea but tracking parens (and respecting strings/braces inside).
  let pd = 1, bd = 0;
  let i = openParenIndex + 1;
  while (i < text.length && pd > 0) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') { i += 2; continue; }
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '(') pd++;
    else if (c === ')') pd--;
    else if (c === '{') bd++;
    else if (c === '}') bd--;
    i++;
  }
  return pd === 0 ? i - 1 : -1;
}

function extractTopLevelOptionsObject(text, callOpenParen, callCloseParen) {
  // Inside the args list (between callOpenParen+1 and callCloseParen-1),
  // find the LAST `{ ... }` that's at paren-depth 1 of the call. That's
  // the options object. Skip strings/comments/nested braces.
  let i = callOpenParen + 1;
  let lastOptionsRange = null;
  while (i < callCloseParen) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') { i += 2; continue; }
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{') {
      const close = findMatchingBrace(text, i);
      if (close > 0 && close < callCloseParen) {
        lastOptionsRange = [i, close];
        i = close + 1;
        continue;
      }
    }
    i++;
  }
  return lastOptionsRange;
}

function extractTopLevelFieldsArray(text, optionsOpen, optionsClose) {
  // Walk inside the options object body. At depth 1 (immediately inside
  // the options braces), find `fields: [ ... ]`. Skip nested objects.
  let i = optionsOpen + 1;
  while (i < optionsClose) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') { i += 2; continue; }
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{') {
      const close = findMatchingBrace(text, i);
      if (close > 0) { i = close + 1; continue; }
    }
    // Check for `fields:` at depth-1
    if (text.slice(i, i + 7) === 'fields:') {
      let j = i + 7;
      while (j < optionsClose && /\s/.test(text[j])) j++;
      if (text[j] === '[') {
        // Find matching ]
        let bd = 1;
        let k = j + 1;
        while (k < optionsClose && bd > 0) {
          if (text[k] === '[') bd++;
          else if (text[k] === ']') bd--;
          if (bd === 0) break;
          k++;
        }
        return [j, k]; // inclusive of brackets
      }
    }
    i++;
  }
  return null;
}

function extractKeysFromArrayLiteral(text, openBracket, closeBracket) {
  const body = text.slice(openBracket + 1, closeBracket);
  const stripped = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Match quoted bare identifiers.
  const matches = stripped.match(/['"][a-zA-Z_][a-zA-Z0-9_]*['"]/g) || [];
  return matches.map(s => s.slice(1, -1));
}

function scanFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  let m;
  FIND_CALL.lastIndex = 0;
  while ((m = FIND_CALL.exec(text)) !== null) {
    const matchEnd = m.index + m[0].length;
    // Find the opening paren of the call's args list.
    let p = matchEnd;
    while (p < text.length && text[p] !== '(') p++;
    if (p >= text.length) continue;
    const closeParen = findArgListClose(text, p);
    if (closeParen < 0) continue;

    // Determine the contentTypeUid:
    let uid;
    if (m[1]) {
      // db.query() flavor — uid is in capture group 1
      uid = m[1];
    } else {
      // entityService — first arg is the uid string
      const firstArgMatch = text.slice(p + 1, closeParen).match(/['"]((?:api|plugin)::[a-zA-Z\-_.]+)['"]/);
      uid = firstArgMatch ? firstArgMatch[1] : null;
    }
    if (!uid) continue;

    const options = extractTopLevelOptionsObject(text, p, closeParen);
    if (!options) continue;
    const fieldsArray = extractTopLevelFieldsArray(text, options[0], options[1]);
    if (!fieldsArray) continue;

    const keys = extractKeysFromArrayLiteral(text, fieldsArray[0], fieldsArray[1]);
    if (keys.length === 0) continue;

    const attrs = SCHEMAS[uid];
    const lineNo = text.slice(0, m.index).split('\n').length;
    if (!attrs) {
      REPORTS.push({ file: filePath, line: lineNo, uid, keys, bogus: [], note: 'schema not loaded' });
      continue;
    }
    const bogus = keys.filter(k => !attrs.has(k));
    if (bogus.length > 0) {
      REPORTS.push({ file: filePath, line: lineNo, uid, keys, bogus });
    }
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

// ─── Step 3: report ───────────────────────────────────────────────────
if (REPORTS.length === 0) {
  console.log('✅ No bogus top-level fields[] keys found.');
  console.log(`(Scanned ${Object.keys(SCHEMAS).length} content type schemas.)`);
  process.exit(0);
}

console.log(`Found ${REPORTS.length} call site(s) with bogus top-level fields[] keys:\n`);
for (const r of REPORTS) {
  console.log(`\n${r.file}:${r.line}`);
  console.log(`  contentType: ${r.uid}`);
  if (r.note) {
    console.log(`  note: ${r.note}`);
    continue;
  }
  console.log(`  fields:      [${r.keys.join(', ')}]`);
  console.log(`  ❌ bogus:    [${r.bogus.join(', ')}]`);
}
console.log(`\nTotal: ${REPORTS.length} call site(s) need fixing.`);
process.exit(1);
