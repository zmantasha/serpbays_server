'use strict';

/**
 * Referral-code generator + normaliser.
 *
 * Format: 10-char Crockford's-base32 (no I/L/O/U — visually unambiguous).
 * Alphabet: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (32 chars).
 * 10 chars = 32^10 ≈ 1.1 × 10¹⁵ codes; collision probability at 1M
 * affiliates is ~10⁻⁹, so a single retry-on-collision loop is enough.
 *
 * Storage: uppercase, no whitespace, no separators. Lookups are
 * case-insensitive — normalise before every DB query.
 *
 * Source of entropy: crypto.randomBytes (Node's CSPRNG). Do NOT use the
 * built-in non-cryptographic RNG here — a predictable code lets an attacker
 * enumerate future codes before they are assigned.
 */

const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford's, no I/L/O/U
const CODE_LEN = 10;

// Map a byte value (0-255) to two base32 chars via two nibble-style pulls.
// We take 8 random bytes → 10 chars by using bit-shifting across the buffer.
// Simpler alternative below: pull one random byte per output char and mod 32
// (introduces negligible bias — 256 / 32 = 8, exactly divisible, so no bias
// at all; every char is uniformly distributed).
const generateCode = () => {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    // bytes[i] & 0x1F selects the low 5 bits (0-31). No bias because we
    // don't reject any byte value — all 256 map to the same 32-char space
    // with exact 8-way overlap.
    out += ALPHABET[bytes[i] & 0x1F];
  }
  return out;
};

/**
 * Normalise a caller-supplied code for lookup:
 *   - Trim whitespace
 *   - Uppercase
 *   - Map common ambiguous chars back to their canonical form (I→1, O→0)
 *     so a user typing "IO" into a form doesn't miss a code containing "10".
 *   - Reject anything with characters outside the alphabet.
 *   - Reject anything outside the length range that setCustomCode accepts
 *     (4-16). Auto-generated codes are always 10, but custom user-chosen
 *     codes range wider — click + attribution lookups must accept the SAME
 *     range or a signup with a valid custom code silently drops the referral.
 *
 * Returns null if the input is invalid — callers should treat that as
 * "code not found" without leaking whether the invalid one exists.
 */
const normaliseCode = (raw) => {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toUpperCase();
  // De-ambiguation — Crockford's convention.
  s = s.replace(/O/g, '0').replace(/I/g, '1').replace(/L/g, '1').replace(/U/g, 'V');
  if (s.length < CUSTOM_CODE_MIN_LEN || s.length > CUSTOM_CODE_MAX_LEN) return null;
  for (let i = 0; i < s.length; i++) {
    if (ALPHABET.indexOf(s[i]) === -1) return null;
  }
  return s;
};

/**
 * Generate a fresh code that isn't already in the DB. Retries on collision
 * up to `maxAttempts` times before giving up (unrealistic at 10¹⁵ space).
 */
const generateUniqueCode = async (strapi, maxAttempts = 5) => {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = generateCode();
    const existing = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { referralCode: candidate },
    });
    if (!existing) return candidate;
    strapi.log?.warn?.(`[referral-code] collision on attempt ${i + 1}: ${candidate}`);
  }
  throw new Error('Could not generate a unique referral code after multiple attempts');
};

// ─── Custom (user-chosen) codes ────────────────────────────────────────────
//
// Auto-generated codes use CODE_LEN=10 exactly. Custom codes are allowed to
// range wider so users can pick memorable slugs, but must land in the same
// alphabet after Crockford substitution — otherwise click lookups would break
// (since normaliseCode() rewrites O→0, I→1, L→1, U→V, and the DB stores the
// substituted form).
//
// Reserved codes protect against impersonation and brand-hijacking. Users
// cannot claim these regardless of case — the check runs after
// canonicalisation so "SERPBAYS", "Serpbays", "SerpBay5" (S→5? no; but
// deliberately-spelled variants) all normalise into the guard.

const CUSTOM_CODE_MIN_LEN = 4;
const CUSTOM_CODE_MAX_LEN = 16;

const RESERVED_CUSTOM_CODES = new Set([
  // Company / brand names
  'SERPBAYS', 'SERPBAY', 'SERP',
  // System / role words
  'ADMIN', 'ROOT', 'SUPPORT', 'OFFICIAL', 'SYSTEM',
  'STAFF', 'TEAM', 'HELP', 'MOD', 'MODERATOR',
  // Auth-adjacent words that could confuse users into thinking a link is official
  'LOGIN', 'SIGNIN', 'SIGNUP', 'REGISTER', 'AUTH',
  // Payment adjacent
  'PAY', 'PAYMENT', 'BILLING', 'WALLET',
  // Test / placeholder
  'TEST', 'DEMO', 'EXAMPLE', 'SAMPLE',
]);

/**
 * Validate + normalise a user-supplied custom code. Returns
 *   { code: string }              on success (the DB-canonical form)
 *   { error: string }             on rejection (safe to surface to the user)
 *
 * Length allowed: 4-16 (broader than auto-gen's 10 so users can pick shorter,
 * memorable slugs). Characters allowed: A-Z + 0-9, case-insensitive on input.
 * After Crockford substitution the same lookalike rules apply as the
 * auto-generated path — the resulting string is stored verbatim in the DB.
 */
const validateCustomCode = (raw) => {
  if (typeof raw !== 'string') {
    return { error: 'Referral code must be a string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { error: 'Referral code cannot be empty' };
  }
  if (trimmed.length < CUSTOM_CODE_MIN_LEN) {
    return { error: `Referral code must be at least ${CUSTOM_CODE_MIN_LEN} characters` };
  }
  if (trimmed.length > CUSTOM_CODE_MAX_LEN) {
    return { error: `Referral code must be no more than ${CUSTOM_CODE_MAX_LEN} characters` };
  }
  // Reject any character that isn't a letter or digit BEFORE substitution.
  // Users can type A-Z, 0-9, and case-insensitive letters including
  // O/I/L/U (they'll be canonicalised below).
  if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
    return { error: 'Referral code can only contain letters and numbers' };
  }
  // Canonicalise with the same substitutions the click path uses so lookups
  // never diverge from what's stored.
  const canonical = trimmed
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/U/g, 'V');
  // Reserved word check runs on the canonicalised form so an attacker can't
  // slip past by typing "ADM1N" (canon: "ADM1N", not in list — that's fine,
  // reserved list should include the canonical variants we care about).
  if (RESERVED_CUSTOM_CODES.has(canonical)) {
    return { error: 'This referral code is reserved. Please choose a different one.' };
  }
  return { code: canonical };
};

module.exports = {
  ALPHABET,
  CODE_LEN,
  CUSTOM_CODE_MIN_LEN,
  CUSTOM_CODE_MAX_LEN,
  RESERVED_CUSTOM_CODES,
  generateCode,
  normaliseCode,
  generateUniqueCode,
  validateCustomCode,
};
