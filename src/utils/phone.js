'use strict';

/**
 * Phone numbers are stored in E.164 (+919540905056) and nothing else.
 *
 * 2026-10-02: `phoneNumber` was a free string that nothing checked, so the
 * handful of numbers on file were a mix of formats — '9540905056',
 * '03087547276', '+44 7700 900123' (a UK number reserved for fiction, i.e.
 * not real). Normalising on write means the column is usable later for SMS
 * OTP, WhatsApp or a support call without a cleanup pass first.
 *
 * The `/max` metadata is used so the line type (MOBILE vs FIXED_LINE) is
 * known — needed the day a verification code has to be sent.
 */
const { parsePhoneNumberFromString, getCountries } = require('libphonenumber-js/max');

// `up_users.country` is not consistent: it holds ISO-2 ('IN', 'US') for some
// rows and the full name ('India', 'United States') for others, plus 'other'
// and ''. Accept either, so an Indian user typing a bare 10-digit number is
// resolved whichever way their country happens to be stored.
const COUNTRY_BY_NAME = (() => {
  const map = new Map();
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    for (const code of getCountries()) {
      const name = names.of(code);
      if (name) map.set(name.toLowerCase(), code);
    }
  } catch (e) {
    // No ICU data - ISO-2 hints still work, names just will not resolve.
  }
  return map;
})();

function toIso2(country) {
  if (typeof country !== 'string') return undefined;
  const trimmed = country.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_BY_NAME.get(trimmed.toLowerCase());
}

/**
 * @param {*} raw            what the user typed
 * @param {string} [country] ISO-2 hint, for numbers typed without +country
 * @returns {{ok: true, value: string, country?: string, type?: string}
 *          |{ok: false, reason: string}}
 */
function normalisePhone(raw, country) {
  if (raw === undefined || raw === null) return { ok: true, value: raw };

  const trimmed = String(raw).trim();
  // An empty string is how the UI clears an optional field - allow it.
  if (trimmed === '') return { ok: true, value: '' };

  const hint = toIso2(country);

  const parsed = parsePhoneNumberFromString(trimmed, hint);

  if (!parsed || !parsed.isValid()) {
    // Without a country hint a national number genuinely cannot be resolved,
    // so say what to do rather than just "invalid".
    if (!trimmed.startsWith('+') && !hint) {
      return { ok: false, reason: 'Add the country code, for example +91 98765 43210.' };
    }
    return { ok: false, reason: 'That phone number is not valid. Check the digits and the country code.' };
  }

  return { ok: true, value: parsed.number, country: parsed.country, type: parsed.getType() };
}

module.exports = { normalisePhone };
