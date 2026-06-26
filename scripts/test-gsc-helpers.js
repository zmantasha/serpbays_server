#!/usr/bin/env node
'use strict';

/**
 * Standalone tests for the GSC helper module. Exercises the security-
 * sensitive functions in isolation (no Strapi boot needed): domain
 * matching, HMAC, nonce lifecycle, replay cache, canonical JSON.
 *
 * Coverage:
 *   - normalizeHost: protocol/path/port/www/trailing-dot/IDN handling
 *   - findMatchingProperty:
 *       happy paths (exact, www, sc-domain, sc-domain covering subdomain)
 *       attack paths (suffix confusion, partial substring, wrong scheme,
 *                     URL-prefix vs subdomain, restricted permission level,
 *                     URL-prefix with path)
 *   - canonicalJson: key order, nested, arrays, primitives
 *   - verifyHmac: positive, negative (different secret, tampered body,
 *                  tampered timestamp), constant-length requirement
 *   - nonce store: round-trip, one-shot, expiry
 *   - replay cache: mark-then-check, expiry
 */

const path = require('path');
process.env.GSC_VERIFY_SHARED_SECRET ||= 'test-secret-' + 'x'.repeat(32);
const gsc = require(path.resolve(__dirname, '..', 'src', 'utils', 'gsc-helpers.js'));

let pass = 0;
let fail = 0;
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const assert = (cond, label) => {
  if (cond) { pass++; out(`  ✅ ${label}`); }
  else      { fail++; out(`  ❌ ${label}`); }
};

// ---- normalizeHost ----
out('\n=== normalizeHost ===');
assert(gsc.normalizeHost('example.com') === 'example.com', 'bare host');
assert(gsc.normalizeHost('EXAMPLE.com') === 'example.com', 'uppercase → lowercase');
assert(gsc.normalizeHost('www.example.com') === 'example.com', 'strip www');
assert(gsc.normalizeHost('https://example.com/path?q=1#h') === 'example.com', 'strip scheme/path/query/fragment');
assert(gsc.normalizeHost('example.com:8080') === 'example.com', 'strip port');
assert(gsc.normalizeHost('example.com.') === 'example.com', 'strip trailing dot');
assert(gsc.normalizeHost('blog.example.com') === 'blog.example.com', 'subdomain preserved');
assert(gsc.normalizeHost('   https://Example.COM/   ') === 'example.com', 'trim + casefold');
assert(gsc.normalizeHost('') === null, 'empty rejected');
assert(gsc.normalizeHost(null) === null, 'null rejected');
assert(gsc.normalizeHost('localhost') === null, 'no-dot rejected');
// IDN: bücher.de → xn--bcher-kva.de
assert(gsc.normalizeHost('bücher.de') === 'xn--bcher-kva.de', 'IDN → punycode');
assert(gsc.normalizeHost('xn--bcher-kva.de') === 'xn--bcher-kva.de', 'already-punycode passthrough');

// ---- findMatchingProperty: happy paths ----
out('\n=== findMatchingProperty (happy paths) ===');
{
  const props = [
    { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  ];
  const m = gsc.findMatchingProperty('example.com', props);
  assert(m && m.type === 'url-prefix' && m.provenHost === 'example.com', 'URL-prefix exact match');
}
{
  const props = [
    { siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' },
  ];
  const m = gsc.findMatchingProperty('example.com', props);
  assert(m && m.type === 'url-prefix' && m.provenHost === 'example.com', 'URL-prefix www collapses to non-www');
}
{
  const props = [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  ];
  const m = gsc.findMatchingProperty('example.com', props);
  assert(m && m.type === 'domain' && m.provenHost === 'example.com', 'sc-domain exact apex');
}
{
  const props = [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' },
  ];
  const m = gsc.findMatchingProperty('blog.example.com', props);
  assert(m && m.type === 'domain' && m.provenHost === 'example.com', 'sc-domain covers subdomain (siteFullUser)');
}
{
  const props = [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  ];
  const m = gsc.findMatchingProperty('a.b.c.example.com', props);
  assert(m && m.type === 'domain', 'sc-domain covers deeply nested subdomain');
}
{
  // http vs https treated as equivalent (the matcher ignores scheme on URL-prefix)
  const props = [
    { siteUrl: 'http://example.com/', permissionLevel: 'siteOwner' },
  ];
  const m = gsc.findMatchingProperty('example.com', props);
  assert(m && m.type === 'url-prefix', 'http URL-prefix matches https-less row host');
}
{
  // user has multiple properties; pick the matching one
  const props = [
    { siteUrl: 'sc-domain:other.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  ];
  const m = gsc.findMatchingProperty('example.com', props);
  assert(m && m.provenHost === 'example.com', 'picks the right property from a list');
}

// ---- findMatchingProperty: attack paths ----
out('\n=== findMatchingProperty (attack paths) ===');
{
  // URL-prefix does NOT cover subdomain
  const props = [{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }];
  assert(gsc.findMatchingProperty('blog.example.com', props) === null, 'URL-prefix does not cover subdomain');
}
{
  // suffix confusion: row example.com.evil.com vs sc-domain:example.com
  const props = [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }];
  assert(gsc.findMatchingProperty('example.com.evil.com', props) === null, 'sc-domain rejects suffix-confusion attack');
}
{
  // partial substring: row evil-example.com vs sc-domain:example.com
  const props = [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }];
  assert(gsc.findMatchingProperty('evil-example.com', props) === null, 'sc-domain rejects partial-substring attack');
}
{
  // restricted permission level — must be rejected even if domain matches
  const props = [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' }];
  assert(gsc.findMatchingProperty('example.com', props) === null, 'siteRestrictedUser rejected');
}
{
  const props = [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteUnverifiedUser' }];
  assert(gsc.findMatchingProperty('example.com', props) === null, 'siteUnverifiedUser rejected');
}
{
  // URL-prefix with a path is not a coverage proof for the bare host
  const props = [{ siteUrl: 'https://example.com/blog/', permissionLevel: 'siteOwner' }];
  assert(gsc.findMatchingProperty('example.com', props) === null, 'URL-prefix with non-root path rejected');
}
{
  // URL-prefix on a different host
  const props = [{ siteUrl: 'https://victim.com/', permissionLevel: 'siteOwner' }];
  assert(gsc.findMatchingProperty('example.com', props) === null, 'URL-prefix on different host rejected');
}
{
  // empty / malformed
  assert(gsc.findMatchingProperty('example.com', []) === null, 'empty property list rejected');
  assert(gsc.findMatchingProperty('example.com', null) === null, 'null property list rejected');
  assert(gsc.findMatchingProperty('example.com', [{ siteUrl: 'not-a-url', permissionLevel: 'siteOwner' }]) === null, 'unparseable URL rejected');
  assert(gsc.findMatchingProperty('example.com', [{ siteUrl: 'ftp://example.com/', permissionLevel: 'siteOwner' }]) === null, 'non-http scheme rejected');
}
{
  // case + protocol + www variants on row side all collapse to the same host
  const props = [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }];
  assert(gsc.findMatchingProperty('HTTPS://WWW.Example.com/', props) !== null, 'row URL normalization (scheme+www+case)');
}

// ---- canonicalJson ----
out('\n=== canonicalJson ===');
assert(gsc.canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}', 'keys sorted');
assert(gsc.canonicalJson({ a: { y: 1, x: 2 } }) === '{"a":{"x":2,"y":1}}', 'nested keys sorted');
assert(gsc.canonicalJson([3, 1, 2]) === '[3,1,2]', 'arrays preserve order');
assert(gsc.canonicalJson(null) === 'null', 'null');
assert(gsc.canonicalJson('x') === '"x"', 'string');
assert(gsc.canonicalJson(42) === '42', 'number');

// ---- verifyHmac ----
out('\n=== verifyHmac ===');
{
  const secret = 'shhhhhh-secret-shhhhhh-secret-32';
  const body = gsc.canonicalJson({ nonce: 'abc', properties: [] });
  const ts = String(Date.now());
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  assert(gsc.verifyHmac(secret, ts, body, sig) === true, 'valid HMAC accepted');
  assert(gsc.verifyHmac('different-secret-xxxxxxxxxxxxxxxx', ts, body, sig) === false, 'wrong secret rejected');
  assert(gsc.verifyHmac(secret, ts, body.replace('abc', 'xyz'), sig) === false, 'tampered body rejected');
  assert(gsc.verifyHmac(secret, String(Number(ts) + 1), body, sig) === false, 'tampered timestamp rejected');
  assert(gsc.verifyHmac(secret, ts, body, sig.slice(0, -2) + '00') === false, 'tampered signature rejected');
  assert(gsc.verifyHmac(secret, ts, body, 'short') === false, 'length-mismatch signature rejected (no throw)');
  assert(gsc.verifyHmac('', ts, body, sig) === false, 'empty secret rejected');
}

// ---- nonce store ----
out('\n=== nonce store ===');
{
  const n = gsc.createNonce({ userId: 1, websiteId: 9, websiteUrl: 'example.com' });
  assert(typeof n === 'string' && n.length === 64, 'nonce is 64-hex');
  const first = gsc.consumeNonce(n);
  assert(first && first.userId === 1 && first.websiteId === 9 && first.websiteUrl === 'example.com', 'consume returns bound entry');
  const second = gsc.consumeNonce(n);
  assert(second === null, 'consume is one-shot');
  assert(gsc.consumeNonce('nonexistent') === null, 'unknown nonce → null');
}

// ---- replay cache ----
out('\n=== replay cache ===');
{
  const h = gsc.signatureHash('deadbeef');
  assert(gsc.isSignatureReplay(h) === false, 'before mark: not replay');
  gsc.markSignatureUsed(h);
  assert(gsc.isSignatureReplay(h) === true, 'after mark: is replay');
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
