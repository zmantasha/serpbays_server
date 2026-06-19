#!/usr/bin/env node
/**
 * Regression test for the country-normalization utility.
 *
 * Reported problem: bulk-import CSVs containing ISO country codes (IN, US,
 * UK, UAE, CZ, ...) were being rejected as invalid because the prior
 * validateValues check only matched canonical names case-insensitively.
 *
 * Fix: src/constants/website-options.js now ships normalizeCountry() /
 * normalizeCountries() that accept canonical names, ISO 3166-1 alpha-2,
 * ISO 3166-1 alpha-3, and common aliases (UK, UAE, Czechia, Burma, etc.).
 * controllers/websites.js bulk-import prepareWebsiteData uses it.
 *
 * Run: cd serpbays_server && node scripts/test-country-normalization.js
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');

const { normalizeCountry, normalizeCountries, COUNTRY_LOOKUP, COUNTRIES, ISO_DATA } =
  require('/var/www/serpbays/serpbays_server/src/constants/website-options');

let pass = 0, fail = 0;
const out = (...a) => process.stderr.write(a.join(' ') + '\n');
const eq = (got, want, label) => {
  if (got === want) { pass++; out('  ✅', label, '→', JSON.stringify(got)); }
  else              { fail++; out('  ❌', label, 'expected', JSON.stringify(want), 'got', JSON.stringify(got)); }
};
const arrEq = (got, want, label) => {
  const a = JSON.stringify(got); const b = JSON.stringify(want);
  if (a === b) { pass++; out('  ✅', label); }
  else         { fail++; out('  ❌', label, 'expected', b, 'got', a); }
};

out('\n=== 1) Reported failing cases from the user — ISO 3166-1 alpha-2 codes ===');
// Exactly the codes listed in the user's bug report.
const reportedCases = {
  'IN':  'India',
  'US':  'United States of America',
  'EE':  'Estonia',
  'UA':  'Ukraine',
  'CZ':  'Czech Republic (Czechia)',
  'SC':  'Seychelles',
  'UK':  'United Kingdom',
  'SK':  'Slovakia',
  'TW':  'Taiwan',
  'SG':  'Singapore',
  'CY':  'Cyprus',
  'CH':  'Switzerland',
  'IL':  'Israel',
  'RS':  'Serbia',
  'UAE': 'United Arab Emirates',
  'PK':  'Pakistan',
  'AU':  'Australia',
  'CA':  'Canada',
  'BR':  'Brazil',
  'AR':  'Argentina',
  'TH':  'Thailand',
  'PH':  'Philippines',
  'DE':  'Germany',
  'FR':  'France',
  'FI':  'Finland',
  'GR':  'Greece',
  'HU':  'Hungary',
  'IT':  'Italy',
  'RO':  'Romania',
};
for (const [input, expected] of Object.entries(reportedCases)) {
  eq(normalizeCountry(input), expected, `normalizeCountry('${input}')`);
}

out('\n=== 2) ISO 3166-1 alpha-3 (3-letter codes) ===');
const alpha3Cases = {
  'USA': 'United States of America',
  'GBR': 'United Kingdom',
  'IND': 'India',
  'ARE': 'United Arab Emirates',
  'CZE': 'Czech Republic (Czechia)',
  'DEU': 'Germany',
  'FRA': 'France',
  'JPN': 'Japan',
  'BRA': 'Brazil',
  'PRK': 'North Korea',
  'KOR': 'South Korea',
  'COD': 'Congo (Kinshasa)',
  'COG': 'Congo (Brazzaville)',
  'CIV': "Ivory Coast (Côte d'Ivoire)",
};
for (const [input, expected] of Object.entries(alpha3Cases)) {
  eq(normalizeCountry(input), expected, `normalizeCountry('${input}')`);
}

out('\n=== 3) Case + whitespace insensitivity ===');
eq(normalizeCountry('in'), 'India', 'lowercase alpha-2');
eq(normalizeCountry('  IN  '), 'India', 'with surrounding whitespace');
eq(normalizeCountry('Us'), 'United States of America', 'mixed-case alpha-2');
eq(normalizeCountry('iNdIa'), 'India', 'mixed-case canonical');
eq(normalizeCountry('UNITED KINGDOM'), 'United Kingdom', 'uppercase canonical');
eq(normalizeCountry('united arab emirates'), 'United Arab Emirates', 'lowercase canonical');

out('\n=== 4) Canonical names pass through (idempotent) ===');
for (const name of COUNTRIES) {
  if (normalizeCountry(name) !== name) {
    fail++; out('  ❌ canonical pass-through failed for', name);
  }
}
pass++;
out(`  ✅ all ${COUNTRIES.length} canonical names pass through normalizeCountry()`);

out('\n=== 5) Common aliases ===');
const aliases = {
  'UK':    'United Kingdom',
  'Great Britain': 'United Kingdom',
  'Britain':       'United Kingdom',
  'UAE':           'United Arab Emirates',
  'Emirates':      'United Arab Emirates',
  'Czechia':       'Czech Republic (Czechia)',
  'Czech Republic':'Czech Republic (Czechia)',
  'Burma':         'Myanmar (Burma)',
  'Myanmar':       'Myanmar (Burma)',
  'Holland':       'Netherlands',
  'Ivory Coast':   "Ivory Coast (Côte d'Ivoire)",
  "Côte d'Ivoire": "Ivory Coast (Côte d'Ivoire)",
  "Cote d'Ivoire": "Ivory Coast (Côte d'Ivoire)",
  'United States': 'United States of America',
  'IV':            "Ivory Coast (Côte d'Ivoire)",  // provider-specific alias; documented exception, not ISO
  'Macedonia':     'North Macedonia',
  'Cape Verde':    'Cabo Verde',
  'Swaziland':     'Eswatini',
  'East Timor':    'Timor-Leste',
  'Türkiye':       'Turkey',
  'Turkiye':       'Turkey',
  'Republic of the Congo':           'Congo (Brazzaville)',
  'Democratic Republic of the Congo':'Congo (Kinshasa)',
  'DRC':           'Congo (Kinshasa)',
  'DR Congo':      'Congo (Kinshasa)',
  'Korea':         'South Korea',
  'Republic of Korea': 'South Korea',
  'Holy See':      'Vatican City (Holy See)',
  'Vatican':       'Vatican City (Holy See)',
};
for (const [input, expected] of Object.entries(aliases)) {
  eq(normalizeCountry(input), expected, `normalizeCountry('${input}')`);
}

out('\n=== 6) Invalid values → null ===');
const invalidCases = [
  '', '   ', 'XX', 'ZZ', 'foo', 'bar', '123', 'United Sttates', null, undefined,
  // Note: 'IV' was previously here as a known-invalid (it's not an ISO
  // code); it is now an explicit provider alias for Ivory Coast — see
  // section 5 above. Remove from this list to avoid contradicting the
  // alias assertion.
];
for (const v of invalidCases) {
  eq(normalizeCountry(v), null, `normalizeCountry(${JSON.stringify(v)}) → null`);
}
eq(normalizeCountry(42), null, 'normalizeCountry(42 → string "42") → null (no country named "42")');
eq(normalizeCountry({}), null, 'normalizeCountry({}) → null');

out('\n=== 7) ISO-2 / ISO-3 round-trip for every country in COUNTRIES ===');
let isoMissCount = 0;
const isoMisses = [];
for (const [canonical, iso2, iso3] of ISO_DATA) {
  if (iso2 && normalizeCountry(iso2) !== canonical) { isoMissCount++; isoMisses.push(`${iso2}→?`); }
  if (iso3 && normalizeCountry(iso3) !== canonical) { isoMissCount++; isoMisses.push(`${iso3}→?`); }
}
if (isoMissCount === 0) {
  pass++; out(`  ✅ every ISO-2 + ISO-3 in ISO_DATA normalizes to its declared canonical (${ISO_DATA.length} entries)`);
} else {
  fail++; out(`  ❌ ${isoMissCount} ISO codes failed round-trip:`, isoMisses.slice(0, 5).join(', '), '…');
}

out('\n=== 8) normalizeCountries (batch) ===');
arrEq(
  normalizeCountries(['IN', 'US', 'UK', 'UAE', 'CZ', 'DE', 'FR']),
  { valid: ['India', 'United States of America', 'United Kingdom', 'United Arab Emirates', 'Czech Republic (Czechia)', 'Germany', 'France'], invalid: [] },
  'happy path — all valid'
);
arrEq(
  normalizeCountries(['IN', 'foobar', 'US', 'zzz']),
  { valid: ['India', 'United States of America'], invalid: ['foobar', 'zzz'] },
  'mixed valid + invalid'
);
arrEq(
  normalizeCountries(['IN', 'India', 'IND', 'in']),
  { valid: ['India'], invalid: [] },
  'dedup across canonical + alpha-2 + alpha-3 + lowercase'
);
arrEq(
  normalizeCountries([]),
  { valid: [], invalid: [] },
  'empty array'
);
arrEq(
  normalizeCountries(null),
  { valid: [], invalid: [] },
  'null input'
);

out('\n=== 9) Edge cases — whitespace + delimiters in CSV cells ===');
// The bulk-import controller already splits ',', then trims, then passes
// here. We verify each piece survives.
const splitted = 'IN, US , UK,uae'.split(',').map(s => s.trim());
arrEq(
  normalizeCountries(splitted),
  { valid: ['India', 'United States of America', 'United Kingdom', 'United Arab Emirates'], invalid: [] },
  'CSV-split + trimmed inputs all normalize correctly'
);

out('\n=== 10) Lookup map sanity ===');
if (COUNTRY_LOOKUP.size >= COUNTRIES.length * 3) {
  pass++; out(`  ✅ COUNTRY_LOOKUP has ${COUNTRY_LOOKUP.size} entries (canonicals + ISO-2 + ISO-3 + aliases)`);
} else {
  fail++; out(`  ❌ COUNTRY_LOOKUP only has ${COUNTRY_LOOKUP.size} entries; expected ≥ ${COUNTRIES.length * 3}`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
