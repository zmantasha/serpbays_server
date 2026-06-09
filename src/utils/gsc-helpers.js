'use strict';

/**
 * Helpers for the Google Search Console (GSC) verification flow.
 *
 * - In-memory nonce store: binds an OAuth `state` value to the publisher row
 *   and user that initiated the flow. The Next.js callback echoes the nonce
 *   back; we consume it once and recover the bound parameters server-side.
 *   This removes the need to trust state contents.
 *
 * - In-memory replay cache: a hash of every accepted HMAC signature is kept
 *   for the timestamp window; duplicates are rejected so a captured payload
 *   can't be played twice.
 *
 * - Canonical JSON: deterministic string representation of an object so the
 *   sender and verifier compute the same HMAC input. Both sides serialize
 *   keys in lexicographic order with no whitespace.
 *
 * - HMAC verify: constant-time over `timestamp + '.' + canonicalBody`.
 *
 * - Domain matching: validates that ANY of the user's GSC properties covers
 *   the publisher row's URL under strict rules (sc-domain covers subdomains;
 *   URL-prefix is exact host only; www stripped; IDN→punycode; reject paths).
 *
 * All structures are process-local. On a single-host deployment that's fine;
 * a restart loses pending nonces (TTL is 10 min so the blast radius is small).
 */

const crypto = require('crypto');

// ---- Nonce store --------------------------------------------------------

const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const nonces = new Map(); // nonce -> { userId, websiteId, websiteUrl, returnTo, expiresAt }

function createNonce({ userId, websiteId, websiteUrl, returnTo }) {
  if (!userId || !websiteId || !websiteUrl) throw new Error('createNonce: missing required field');
  const nonce = crypto.randomBytes(32).toString('hex');
  nonces.set(nonce, {
    userId,
    websiteId,
    websiteUrl,
    returnTo: returnTo || null,
    expiresAt: Date.now() + NONCE_TTL_MS,
  });
  return nonce;
}

// One-shot consume. Returns the bound entry, then deletes it. Returns null if
// missing/expired.
function consumeNonce(nonce) {
  if (!nonce) return null;
  const entry = nonces.get(nonce);
  if (!entry) return null;
  nonces.delete(nonce);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// ---- Replay cache -------------------------------------------------------

const REPLAY_TTL_MS = 5 * 60 * 1000; // matches the timestamp window
const replays = new Map(); // sigHash -> expiresAt

function markSignatureUsed(sigHash) {
  replays.set(sigHash, Date.now() + REPLAY_TTL_MS);
}

function isSignatureReplay(sigHash) {
  const exp = replays.get(sigHash);
  if (!exp) return false;
  if (exp < Date.now()) {
    replays.delete(sigHash);
    return false;
  }
  return true;
}

// Periodic cleanup so the maps don't grow unbounded under sustained traffic.
// Survives setInterval being called multiple times (Strapi reload-safe).
if (!global.__gscHelperGcStarted) {
  global.__gscHelperGcStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of nonces) if (v.expiresAt < now) nonces.delete(k);
    for (const [k, v] of replays) if (v < now) replays.delete(k);
  }, 60 * 1000).unref();
}

// ---- Canonical JSON -----------------------------------------------------

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]));
  return '{' + parts.join(',') + '}';
}

// ---- HMAC verify --------------------------------------------------------

function verifyHmac(secret, timestamp, canonicalBody, providedHex) {
  if (!secret || !timestamp || canonicalBody == null || !providedHex) return false;
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${canonicalBody}`)
    .digest('hex');
  // Buffer comparison must be the same length, else timingSafeEqual throws.
  if (expectedHex.length !== providedHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(providedHex, 'hex'));
  } catch {
    return false;
  }
}

function signatureHash(signatureHex) {
  return crypto.createHash('sha256').update(signatureHex).digest('hex');
}

// ---- Domain normalization + matching -----------------------------------

/**
 * Normalize a hostname for comparison.
 * - Strips protocol, path, query, fragment, port, trailing dot.
 * - Lowercases.
 * - IDN → punycode (via URL API).
 * - Strips leading `www.` so www/non-www variants collapse.
 * Returns null on inputs that aren't a valid host.
 */
function normalizeHost(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.split(':')[0];
  s = s.replace(/\.+$/, '');
  if (!s) return null;
  let host;
  try {
    host = new URL('http://' + s).hostname; // produces punycode for IDN
  } catch {
    return null;
  }
  if (!host) return null;
  host = host.replace(/^www\./, '');
  // Sanity: must have at least one dot (not 'localhost' etc.)
  if (!host.includes('.')) return null;
  // Disallow trailing-dot-stripped to empty
  return host;
}

const ALLOWED_PERMISSIONS = new Set(['siteOwner', 'siteFullUser']);

/**
 * Given the publisher row's URL and the list of GSC properties returned for
 * the OAuth'd Google account, find a property that covers the row's host.
 *
 * Matching rules:
 *   sc-domain:X         → covers X and all subdomains of X (eTLD-aware via
 *                          strict suffix check `host === X || host.endsWith('.' + X)`).
 *   https?://X/         → covers exactly host X (www collapsed). Paths other
 *                          than '/' are rejected (URL-prefix verifies a path,
 *                          not the bare host).
 *
 * Permission level must be siteOwner or siteFullUser. siteRestrictedUser and
 * siteUnverifiedUser are explicitly rejected.
 *
 * Returns the matched property descriptor (with normalized fields for
 * logging) or null if nothing matches.
 */
function findMatchingProperty(rowUrl, properties) {
  const rowHost = normalizeHost(rowUrl);
  if (!rowHost) return null;
  if (!Array.isArray(properties)) return null;

  for (const prop of properties) {
    if (!prop || typeof prop.siteUrl !== 'string') continue;
    if (!ALLOWED_PERMISSIONS.has(prop.permissionLevel)) continue;
    const siteUrl = prop.siteUrl;

    if (siteUrl.startsWith('sc-domain:')) {
      const provenDomain = normalizeHost(siteUrl.slice('sc-domain:'.length));
      if (!provenDomain) continue;
      // Strict subdomain check: must be exact or `host` ends with `.provenDomain`.
      // Using the leading-dot guard prevents `evil.com` matching `sc-domain:com`
      // or `example.com.evil.com` matching `sc-domain:example.com`.
      if (rowHost === provenDomain || rowHost.endsWith('.' + provenDomain)) {
        return {
          type: 'domain',
          siteUrl,
          provenHost: provenDomain,
          permissionLevel: prop.permissionLevel,
        };
      }
      continue;
    }

    // URL-prefix property. Must be parseable. Path must be root '/'.
    let urlObj;
    try {
      urlObj = new URL(siteUrl);
    } catch {
      continue;
    }
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') continue;
    if (urlObj.pathname && urlObj.pathname !== '/') continue;
    if (urlObj.search || urlObj.hash) continue;

    const provenHost = normalizeHost(urlObj.hostname);
    if (!provenHost) continue;
    // URL-prefix does NOT cover subdomains — exact host only.
    if (rowHost === provenHost) {
      return {
        type: 'url-prefix',
        siteUrl,
        provenHost,
        permissionLevel: prop.permissionLevel,
      };
    }
  }

  return null;
}

module.exports = {
  createNonce,
  consumeNonce,
  markSignatureUsed,
  isSignatureReplay,
  canonicalJson,
  verifyHmac,
  signatureHash,
  normalizeHost,
  findMatchingProperty,
  // exposed for tests
  _internal: { nonces, replays, NONCE_TTL_MS, REPLAY_TTL_MS },
};
