'use strict';

const COUNTRIES = [
  'Antigua and Barbuda', 'Bahamas', 'Barbados', 'Belize', 'Canada', 'Costa Rica', 'Cuba',
  'Dominica', 'Dominican Republic', 'El Salvador', 'Grenada', 'Guatemala', 'Haiti', 'Honduras',
  'Jamaica', 'Mexico', 'Nicaragua', 'Panama', 'Saint Kitts and Nevis', 'Saint Lucia',
  'Saint Vincent and the Grenadines', 'Trinidad and Tobago', 'United States of America',
  'Argentina', 'Bolivia', 'Brazil', 'Chile', 'Colombia', 'Ecuador', 'Guyana', 'Paraguay',
  'Peru', 'Suriname', 'Uruguay', 'Venezuela',
  'Albania', 'Andorra', 'Armenia', 'Austria', 'Azerbaijan', 'Belarus', 'Belgium',
  'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Cyprus', 'Czech Republic (Czechia)',
  'Denmark', 'Estonia', 'Finland', 'France', 'Georgia', 'Germany', 'Greece', 'Hungary',
  'Iceland', 'Ireland', 'Italy', 'Kazakhstan', 'Kosovo', 'Latvia', 'Liechtenstein',
  'Lithuania', 'Luxembourg', 'Malta', 'Moldova', 'Monaco', 'Montenegro', 'Netherlands',
  'North Macedonia', 'Norway', 'Poland', 'Portugal', 'Romania', 'Russia', 'San Marino',
  'Serbia', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Ukraine',
  'United Kingdom', 'Vatican City (Holy See)',
  'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cabo Verde',
  'Cameroon', 'Central African Republic', 'Chad', 'Comoros', 'Congo (Brazzaville)',
  'Congo (Kinshasa)', 'Djibouti', 'Egypt', 'Equatorial Guinea', 'Eritrea', 'Eswatini',
  'Ethiopia', 'Gabon', 'Gambia', 'Ghana', 'Guinea', 'Guinea-Bissau',
  'Ivory Coast (Côte d\'Ivoire)', 'Kenya', 'Lesotho', 'Liberia', 'Libya', 'Madagascar',
  'Malawi', 'Mali', 'Mauritania', 'Mauritius', 'Morocco', 'Mozambique', 'Namibia', 'Niger',
  'Nigeria', 'Rwanda', 'São Tomé and Príncipe', 'Senegal', 'Seychelles', 'Sierra Leone',
  'Somalia', 'South Africa', 'South Sudan', 'Sudan', 'Tanzania', 'Togo', 'Tunisia', 'Uganda',
  'Zambia', 'Zimbabwe',
  'Afghanistan', 'Bahrain', 'Bangladesh', 'Bhutan', 'Brunei', 'Cambodia', 'China', 'India',
  'Indonesia', 'Iran', 'Iraq', 'Israel', 'Japan', 'Jordan', 'Kuwait', 'Kyrgyzstan', 'Laos',
  'Lebanon', 'Malaysia', 'Maldives', 'Mongolia', 'Myanmar (Burma)', 'Nepal', 'North Korea',
  'Oman', 'Pakistan', 'Palestine', 'Philippines', 'Qatar', 'Saudi Arabia', 'Singapore',
  'South Korea', 'Sri Lanka', 'Syria', 'Taiwan', 'Tajikistan', 'Thailand', 'Timor-Leste',
  'Turkmenistan', 'Turkey', 'United Arab Emirates', 'Uzbekistan', 'Vietnam', 'Yemen',
  'Australia', 'Fiji', 'Kiribati', 'Marshall Islands', 'Micronesia', 'Nauru', 'New Zealand',
  'Palau', 'Papua New Guinea', 'Samoa', 'Solomon Islands', 'Tonga', 'Tuvalu', 'Vanuatu',
  'Global',
];

const LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Russian',
  'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean', 'Arabic', 'Turkish',
  'Hindi', 'Bengali', 'Urdu', 'Vietnamese', 'Thai', 'Polish', 'Romanian', 'Swedish', 'Danish',
  'Norwegian', 'Finnish', 'Czech', 'Hungarian', 'Greek', 'Slovak', 'Bulgarian', 'Serbian',
  'Croatian', 'Ukrainian', 'Lithuanian', 'Latvian', 'Estonian', 'Slovenian', 'Hebrew',
  'Farsi (Persian)', 'Malay', 'Indonesian', 'Tamil', 'Kannada', 'Gujarati', 'Marathi',
  'Nepali', 'Sinhala', 'Burmese', 'Khmer (Cambodian)', 'Lao', 'Pashto', 'Swahili', 'Hausa',
  'Amharic', 'Yoruba', 'Igbo', 'Zulu', 'Afrikaans', 'Filipino (Tagalog)', 'Bosnian',
  'Macedonian', 'Armenian', 'Georgian', 'Azerbaijani', 'Kazakh', 'Uzbek',
];

const CATEGORIES = [
  'Agriculture', 'Animals & Pets', 'Arms and Ammunition', 'Arts & Entertainment', 'Automobiles',
  'Beauty', 'Blogging', 'Business', 'Career & Employment', 'Computer & Electronics',
  'Coupons Offers & Cashback', 'Cryptocurrency', 'Digital Marketing', 'Ecommerce', 'Education',
  'Environment', 'Family', 'Fashion & Lifestyle', 'Finance', 'Food & Drink', 'Games', 'General',
  'Gift', 'Health & Fitness', 'Home & Garden', 'Humor', 'Internet & Telecom',
  'Law & Government', 'Leisure & Hobbies', 'Magazine', 'Manufacturing',
  'Marketing & Advertising', 'Music', 'News & Media', 'Photography', 'Politics', 'Quotes',
  'Real Estate', 'Region', 'Reviews', 'SaaS', 'Science', 'Shopping', 'Spanish', 'Sports',
  'Spirituality', 'Technology', 'Travelling', 'Web Development', 'Wedding',
];

// Build lowercase lookup maps for case-insensitive matching
const COUNTRIES_MAP = new Map(COUNTRIES.map(c => [c.toLowerCase(), c]));
const LANGUAGES_MAP = new Map(LANGUAGES.map(l => [l.toLowerCase(), l]));
const CATEGORIES_MAP = new Map(CATEGORIES.map(c => [c.toLowerCase(), c]));

// ─────────────────────────────────────────────────────────────────────────
// ISO 3166 country-code + common-alias map. Each row is:
//   [canonicalName, isoAlpha2, isoAlpha3, ...extraAliases]
// All variants resolve to the canonical name from COUNTRIES above. Aliases
// MUST point at a canonical that exists in the COUNTRIES list; the build
// step below logs (and skips) any orphan reference.
//
// Covers every country in the COUNTRIES list plus common variants the user
// reported (UK, UAE, US, etc.) and a handful of well-known synonyms (Burma,
// Czechia, Côte d'Ivoire, DR Congo, etc.) Bulk-import CSVs that use ISO-2
// or ISO-3 codes are now normalized to the canonical name automatically.
// ─────────────────────────────────────────────────────────────────────────
const ISO_DATA = [
  // North America / Caribbean
  ['Antigua and Barbuda', 'AG', 'ATG'],
  ['Bahamas', 'BS', 'BHS'],
  ['Barbados', 'BB', 'BRB'],
  ['Belize', 'BZ', 'BLZ'],
  ['Canada', 'CA', 'CAN'],
  ['Costa Rica', 'CR', 'CRI'],
  ['Cuba', 'CU', 'CUB'],
  ['Dominica', 'DM', 'DMA'],
  ['Dominican Republic', 'DO', 'DOM'],
  ['El Salvador', 'SV', 'SLV'],
  ['Grenada', 'GD', 'GRD'],
  ['Guatemala', 'GT', 'GTM'],
  ['Haiti', 'HT', 'HTI'],
  ['Honduras', 'HN', 'HND'],
  ['Jamaica', 'JM', 'JAM'],
  ['Mexico', 'MX', 'MEX'],
  ['Nicaragua', 'NI', 'NIC'],
  ['Panama', 'PA', 'PAN'],
  ['Saint Kitts and Nevis', 'KN', 'KNA'],
  ['Saint Lucia', 'LC', 'LCA'],
  ['Saint Vincent and the Grenadines', 'VC', 'VCT'],
  ['Trinidad and Tobago', 'TT', 'TTO'],
  ['United States of America', 'US', 'USA', 'United States', 'America'],

  // South America
  ['Argentina', 'AR', 'ARG'],
  ['Bolivia', 'BO', 'BOL'],
  ['Brazil', 'BR', 'BRA'],
  ['Chile', 'CL', 'CHL'],
  ['Colombia', 'CO', 'COL'],
  ['Ecuador', 'EC', 'ECU'],
  ['Guyana', 'GY', 'GUY'],
  ['Paraguay', 'PY', 'PRY'],
  ['Peru', 'PE', 'PER'],
  ['Suriname', 'SR', 'SUR'],
  ['Uruguay', 'UY', 'URY'],
  ['Venezuela', 'VE', 'VEN'],

  // Europe
  ['Albania', 'AL', 'ALB'],
  ['Andorra', 'AD', 'AND'],
  ['Armenia', 'AM', 'ARM'],
  ['Austria', 'AT', 'AUT'],
  ['Azerbaijan', 'AZ', 'AZE'],
  ['Belarus', 'BY', 'BLR'],
  ['Belgium', 'BE', 'BEL'],
  ['Bosnia and Herzegovina', 'BA', 'BIH'],
  ['Bulgaria', 'BG', 'BGR'],
  ['Croatia', 'HR', 'HRV'],
  ['Cyprus', 'CY', 'CYP'],
  ['Czech Republic (Czechia)', 'CZ', 'CZE', 'Czech Republic', 'Czechia'],
  ['Denmark', 'DK', 'DNK'],
  ['Estonia', 'EE', 'EST'],
  ['Finland', 'FI', 'FIN'],
  ['France', 'FR', 'FRA'],
  ['Georgia', 'GE', 'GEO'],
  ['Germany', 'DE', 'DEU'],
  ['Greece', 'GR', 'GRC'],
  ['Hungary', 'HU', 'HUN'],
  ['Iceland', 'IS', 'ISL'],
  ['Ireland', 'IE', 'IRL'],
  ['Italy', 'IT', 'ITA'],
  ['Kazakhstan', 'KZ', 'KAZ'],
  ['Kosovo', 'XK', 'XKX'],
  ['Latvia', 'LV', 'LVA'],
  ['Liechtenstein', 'LI', 'LIE'],
  ['Lithuania', 'LT', 'LTU'],
  ['Luxembourg', 'LU', 'LUX'],
  ['Malta', 'MT', 'MLT'],
  ['Moldova', 'MD', 'MDA'],
  ['Monaco', 'MC', 'MCO'],
  ['Montenegro', 'ME', 'MNE'],
  ['Netherlands', 'NL', 'NLD', 'Holland'],
  ['North Macedonia', 'MK', 'MKD', 'Macedonia'],
  ['Norway', 'NO', 'NOR'],
  ['Poland', 'PL', 'POL'],
  ['Portugal', 'PT', 'PRT'],
  ['Romania', 'RO', 'ROU'],
  ['Russia', 'RU', 'RUS', 'Russian Federation'],
  ['San Marino', 'SM', 'SMR'],
  ['Serbia', 'RS', 'SRB'],
  ['Slovakia', 'SK', 'SVK', 'Slovak Republic'],
  ['Slovenia', 'SI', 'SVN'],
  ['Spain', 'ES', 'ESP'],
  ['Sweden', 'SE', 'SWE'],
  ['Switzerland', 'CH', 'CHE'],
  ['Ukraine', 'UA', 'UKR'],
  ['United Kingdom', 'GB', 'GBR', 'UK', 'Great Britain', 'Britain'],
  ['Vatican City (Holy See)', 'VA', 'VAT', 'Vatican City', 'Vatican', 'Holy See'],

  // Africa
  ['Algeria', 'DZ', 'DZA'],
  ['Angola', 'AO', 'AGO'],
  ['Benin', 'BJ', 'BEN'],
  ['Botswana', 'BW', 'BWA'],
  ['Burkina Faso', 'BF', 'BFA'],
  ['Burundi', 'BI', 'BDI'],
  ['Cabo Verde', 'CV', 'CPV', 'Cape Verde'],
  ['Cameroon', 'CM', 'CMR'],
  ['Central African Republic', 'CF', 'CAF', 'CAR'],
  ['Chad', 'TD', 'TCD'],
  ['Comoros', 'KM', 'COM'],
  ['Congo (Brazzaville)', 'CG', 'COG', 'Republic of the Congo', 'Congo-Brazzaville'],
  ['Congo (Kinshasa)', 'CD', 'COD', 'Democratic Republic of the Congo', 'DR Congo', 'DRC', 'Congo-Kinshasa'],
  ['Djibouti', 'DJ', 'DJI'],
  ['Egypt', 'EG', 'EGY'],
  ['Equatorial Guinea', 'GQ', 'GNQ'],
  ['Eritrea', 'ER', 'ERI'],
  ['Eswatini', 'SZ', 'SWZ', 'Swaziland'],
  ['Ethiopia', 'ET', 'ETH'],
  ['Gabon', 'GA', 'GAB'],
  ['Gambia', 'GM', 'GMB'],
  ['Ghana', 'GH', 'GHA'],
  ['Guinea', 'GN', 'GIN'],
  ['Guinea-Bissau', 'GW', 'GNB'],
  // 'IV' is NOT an ISO code (real ISO-2 is 'CI') — provider-specific
  // abbreviation used in some incoming CSV datasets. Accepted as an alias
  // so frontend + backend agree. Remove this entry if 'IV' ever needs to
  // mean something else for a different data source.
  ["Ivory Coast (Côte d'Ivoire)", 'CI', 'CIV', 'Ivory Coast', "Côte d'Ivoire", "Cote d'Ivoire", 'IV'],
  ['Kenya', 'KE', 'KEN'],
  ['Lesotho', 'LS', 'LSO'],
  ['Liberia', 'LR', 'LBR'],
  ['Libya', 'LY', 'LBY'],
  ['Madagascar', 'MG', 'MDG'],
  ['Malawi', 'MW', 'MWI'],
  ['Mali', 'ML', 'MLI'],
  ['Mauritania', 'MR', 'MRT'],
  ['Mauritius', 'MU', 'MUS'],
  ['Morocco', 'MA', 'MAR'],
  ['Mozambique', 'MZ', 'MOZ'],
  ['Namibia', 'NA', 'NAM'],
  ['Niger', 'NE', 'NER'],
  ['Nigeria', 'NG', 'NGA'],
  ['Rwanda', 'RW', 'RWA'],
  ['São Tomé and Príncipe', 'ST', 'STP', 'Sao Tome and Principe'],
  ['Senegal', 'SN', 'SEN'],
  ['Seychelles', 'SC', 'SYC'],
  ['Sierra Leone', 'SL', 'SLE'],
  ['Somalia', 'SO', 'SOM'],
  ['South Africa', 'ZA', 'ZAF', 'RSA'],
  ['South Sudan', 'SS', 'SSD'],
  ['Sudan', 'SD', 'SDN'],
  ['Tanzania', 'TZ', 'TZA'],
  ['Togo', 'TG', 'TGO'],
  ['Tunisia', 'TN', 'TUN'],
  ['Uganda', 'UG', 'UGA'],
  ['Zambia', 'ZM', 'ZMB'],
  ['Zimbabwe', 'ZW', 'ZWE'],

  // Asia / Middle East
  ['Afghanistan', 'AF', 'AFG'],
  ['Bahrain', 'BH', 'BHR'],
  ['Bangladesh', 'BD', 'BGD'],
  ['Bhutan', 'BT', 'BTN'],
  ['Brunei', 'BN', 'BRN', 'Brunei Darussalam'],
  ['Cambodia', 'KH', 'KHM'],
  ['China', 'CN', 'CHN', "People's Republic of China", 'PRC'],
  ['India', 'IN', 'IND'],
  ['Indonesia', 'ID', 'IDN'],
  ['Iran', 'IR', 'IRN', 'Islamic Republic of Iran'],
  ['Iraq', 'IQ', 'IRQ'],
  ['Israel', 'IL', 'ISR'],
  ['Japan', 'JP', 'JPN'],
  ['Jordan', 'JO', 'JOR'],
  ['Kuwait', 'KW', 'KWT'],
  ['Kyrgyzstan', 'KG', 'KGZ', 'Kyrgyz Republic'],
  ['Laos', 'LA', 'LAO', "Lao People's Democratic Republic"],
  ['Lebanon', 'LB', 'LBN'],
  ['Malaysia', 'MY', 'MYS'],
  ['Maldives', 'MV', 'MDV'],
  ['Mongolia', 'MN', 'MNG'],
  ['Myanmar (Burma)', 'MM', 'MMR', 'Myanmar', 'Burma'],
  ['Nepal', 'NP', 'NPL'],
  ['North Korea', 'KP', 'PRK', 'Korea (North)', "Democratic People's Republic of Korea", 'DPRK'],
  ['Oman', 'OM', 'OMN'],
  ['Pakistan', 'PK', 'PAK'],
  ['Palestine', 'PS', 'PSE', 'Palestinian Territory', 'State of Palestine'],
  ['Philippines', 'PH', 'PHL'],
  ['Qatar', 'QA', 'QAT'],
  ['Saudi Arabia', 'SA', 'SAU', 'KSA'],
  ['Singapore', 'SG', 'SGP'],
  ['South Korea', 'KR', 'KOR', 'Korea', 'Korea (South)', 'Republic of Korea', 'ROK'],
  ['Sri Lanka', 'LK', 'LKA'],
  ['Syria', 'SY', 'SYR', 'Syrian Arab Republic'],
  ['Taiwan', 'TW', 'TWN', 'Republic of China', 'ROC'],
  ['Tajikistan', 'TJ', 'TJK'],
  ['Thailand', 'TH', 'THA'],
  ['Timor-Leste', 'TL', 'TLS', 'East Timor'],
  ['Turkmenistan', 'TM', 'TKM'],
  ['Turkey', 'TR', 'TUR', 'Türkiye', 'Turkiye'],
  ['United Arab Emirates', 'AE', 'ARE', 'UAE', 'Emirates'],
  ['Uzbekistan', 'UZ', 'UZB'],
  ['Vietnam', 'VN', 'VNM', 'Viet Nam'],
  ['Yemen', 'YE', 'YEM'],

  // Oceania
  ['Australia', 'AU', 'AUS'],
  ['Fiji', 'FJ', 'FJI'],
  ['Kiribati', 'KI', 'KIR'],
  ['Marshall Islands', 'MH', 'MHL'],
  ['Micronesia', 'FM', 'FSM', 'Federated States of Micronesia'],
  ['Nauru', 'NR', 'NRU'],
  ['New Zealand', 'NZ', 'NZL'],
  ['Palau', 'PW', 'PLW'],
  ['Papua New Guinea', 'PG', 'PNG'],
  ['Samoa', 'WS', 'WSM'],
  ['Solomon Islands', 'SB', 'SLB'],
  ['Tonga', 'TO', 'TON'],
  ['Tuvalu', 'TV', 'TVL'],
  ['Vanuatu', 'VU', 'VUT'],

  // Special platform value (no ISO)
  ['Global', null, null, 'Worldwide', 'All', 'International'],
];

// Build the unified country lookup. Lowercase key → canonical name.
// Canonical names from COUNTRIES are seeded first, then all aliases.
// Earlier entries win on collision (defensive — should never collide).
const COUNTRY_LOOKUP = (() => {
  const map = new Map();
  for (const c of COUNTRIES) {
    map.set(c.toLowerCase(), c);
  }
  for (const [canonical, ...aliases] of ISO_DATA) {
    if (!COUNTRIES.includes(canonical)) {
      // eslint-disable-next-line no-console
      console.warn(`[website-options] ISO_DATA references unknown canonical: "${canonical}". Skipping its aliases.`);
      continue;
    }
    for (const alias of aliases) {
      if (alias == null) continue;
      const key = String(alias).toLowerCase().trim();
      if (!key) continue;
      // Don't overwrite an existing entry (canonical names win over aliases,
      // and earlier aliases win over later ones).
      if (!map.has(key)) {
        map.set(key, canonical);
      }
    }
  }
  return map;
})();

/**
 * Normalize a single country value to its canonical name.
 * Accepts the canonical name, ISO 3166-1 alpha-2, ISO 3166-1 alpha-3, or any
 * registered alias (case- and whitespace-insensitive).
 * Returns the canonical name on success, or null if the input is invalid.
 *
 * Examples:
 *   normalizeCountry('IN')       → 'India'
 *   normalizeCountry('us')       → 'United States of America'
 *   normalizeCountry('UK')       → 'United Kingdom'
 *   normalizeCountry('UAE')      → 'United Arab Emirates'
 *   normalizeCountry('Czech Republic') → 'Czech Republic (Czechia)'
 *   normalizeCountry('foobar')   → null
 */
function normalizeCountry(value) {
  if (value == null) return null;
  if (typeof value !== 'string') value = String(value);
  const trimmed = value.trim();
  if (!trimmed) return null;
  return COUNTRY_LOOKUP.get(trimmed.toLowerCase()) || null;
}

/**
 * Normalize an array of country values. Dedupes the valid list.
 * Returns { valid: string[], invalid: string[] }.
 */
function normalizeCountries(values) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  if (!Array.isArray(values)) return { valid, invalid };
  for (const val of values) {
    const normalized = normalizeCountry(val);
    if (normalized) {
      if (!seen.has(normalized)) {
        seen.add(normalized);
        valid.push(normalized);
      }
    } else {
      invalid.push(typeof val === 'string' ? val.trim() : String(val));
    }
  }
  return { valid, invalid };
}

/**
 * Validate and normalize a value against a predefined list (case-insensitive).
 * Returns the correctly-cased value if valid, or null if invalid.
 */
function validateValue(value, lookupMap) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return lookupMap.get(trimmed.toLowerCase()) || null;
}

/**
 * Validate and filter an array of values against a predefined list.
 * Returns { valid: string[], invalid: string[] }
 */
function validateValues(values, lookupMap) {
  const valid = [];
  const invalid = [];

  for (const val of values) {
    const normalized = validateValue(val, lookupMap);
    if (normalized) {
      valid.push(normalized);
    } else {
      invalid.push(val.trim());
    }
  }

  return { valid, invalid };
}

module.exports = {
  COUNTRIES,
  LANGUAGES,
  CATEGORIES,
  COUNTRIES_MAP,
  LANGUAGES_MAP,
  CATEGORIES_MAP,
  COUNTRY_LOOKUP,
  ISO_DATA,
  validateValue,
  validateValues,
  normalizeCountry,
  normalizeCountries,
};
