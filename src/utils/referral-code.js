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
 *   - Reject anything with characters outside the alphabet or wrong length.
 * Returns null if the input is invalid — callers should treat that as
 * "code not found" without leaking whether the invalid one exists.
 */
const normaliseCode = (raw) => {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toUpperCase();
  // De-ambiguation — Crockford's convention.
  s = s.replace(/O/g, '0').replace(/I/g, '1').replace(/L/g, '1').replace(/U/g, 'V');
  if (s.length !== CODE_LEN) return null;
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

module.exports = {
  ALPHABET,
  CODE_LEN,
  generateCode,
  normaliseCode,
  generateUniqueCode,
};
