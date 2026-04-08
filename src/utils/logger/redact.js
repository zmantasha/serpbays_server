'use strict';

/**
 * Deep redaction utility for the API logger.
 *
 * - Walks plain objects + arrays and replaces values whose keys match the
 *   sensitive list with the string '[REDACTED]'.
 * - Case-insensitive key match.
 * - In `responseOnly` mode, also strips PII fields (email, phone, phoneNumber)
 *   from response bodies. Request bodies keep email so support can correlate
 *   a captured request to a real user.
 * - Cycle-safe via WeakSet.
 * - Never throws — on any internal error returns the original value untouched
 *   so the logging path stays defensive.
 */

const SENSITIVE_KEYS = [
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'token',
  'jwt',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'resetpasswordtoken',
  'confirmationtoken',
  'cookie',
  'cookies',
  'set-cookie',
];

const PII_KEYS = ['email', 'phone', 'phonenumber', 'phone_number'];

const REDACTED = '[REDACTED]';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldRedactKey(key, alsoStripPii) {
  const lower = String(key).toLowerCase();
  if (SENSITIVE_KEYS.includes(lower)) return true;
  if (alsoStripPii && PII_KEYS.includes(lower)) return true;
  return false;
}

function walk(value, alsoStripPii, seen) {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => walk(item, alsoStripPii, seen));
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (shouldRedactKey(k, alsoStripPii)) {
        out[k] = REDACTED;
      } else {
        out[k] = walk(v, alsoStripPii, seen);
      }
    }
    return out;
  }

  return value;
}

/**
 * @param {any} value - the body / headers object to scrub.
 * @param {{ responseOnly?: boolean }} [opts]
 * @returns {any} a new value with sensitive fields redacted.
 */
function redact(value, opts = {}) {
  try {
    return walk(value, !!opts.responseOnly, new WeakSet());
  } catch (_e) {
    // Defensive: never let a redaction failure break logging.
    return value;
  }
}

module.exports = {
  redact,
  SENSITIVE_KEYS,
  PII_KEYS,
  REDACTED,
};
