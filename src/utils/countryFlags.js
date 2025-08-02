// Country name to ISO code mapping
const countryMapping = {
  // North America
  "Antigua and Barbuda": "ag",
  "Bahamas": "bs",
  "Barbados": "bb",
  "Belize": "bz",
  "Canada": "ca",
  "Costa Rica": "cr",
  "Cuba": "cu",
  "Dominica": "dm",
  "Dominican Republic": "do",
  "El Salvador": "sv",
  "Grenada": "gd",
  "Guatemala": "gt",
  "Haiti": "ht",
  "Honduras": "hn",
  "Jamaica": "jm",
  "Mexico": "mx",
  "Nicaragua": "ni",
  "Panama": "pa",
  "Saint Kitts and Nevis": "kn",
  "Saint Lucia": "lc",
  "Saint Vincent and the Grenadines": "vc",
  "Trinidad and Tobago": "tt",
  "United States of America": "us",
  "United States": "us",
  "USA": "us",

  // South America
  "Argentina": "ar",
  "Bolivia": "bo",
  "Brazil": "br",
  "Chile": "cl",
  "Colombia": "co",
  "Ecuador": "ec",
  "Guyana": "gy",
  "Paraguay": "py",
  "Peru": "pe",
  "Suriname": "sr",
  "Uruguay": "uy",
  "Venezuela": "ve",

  // Europe
  "Albania": "al",
  "Andorra": "ad",
  "Armenia": "am",
  "Austria": "at",
  "Azerbaijan": "az",
  "Belarus": "by",
  "Belgium": "be",
  "Bosnia and Herzegovina": "ba",
  "Bulgaria": "bg",
  "Croatia": "hr",
  "Cyprus": "cy",
  "Czech Republic (Czechia)": "cz",
  "Czech Republic": "cz",
  "Czechia": "cz",
  "Denmark": "dk",
  "Estonia": "ee",
  "Finland": "fi",
  "France": "fr",
  "Georgia": "ge",
  "Germany": "de",
  "Greece": "gr",
  "Hungary": "hu",
  "Iceland": "is",
  "Ireland": "ie",
  "Italy": "it",
  "Kazakhstan": "kz",
  "Kosovo": "xk",
  "Latvia": "lv",
  "Liechtenstein": "li",
  "Lithuania": "lt",
  "Luxembourg": "lu",
  "Malta": "mt",
  "Moldova": "md",
  "Monaco": "mc",
  "Montenegro": "me",
  "Netherlands": "nl",
  "North Macedonia": "mk",
  "Norway": "no",
  "Poland": "pl",
  "Portugal": "pt",
  "Romania": "ro",
  "Russia": "ru",
  "San Marino": "sm",
  "Serbia": "rs",
  "Slovakia": "sk",
  "Slovenia": "si",
  "Spain": "es",
  "Sweden": "se",
  "Switzerland": "ch",
  "Ukraine": "ua",
  "United Kingdom": "gb",
  "UK": "gb",
  "Vatican City (Holy See)": "va",

  // Africa
  "Algeria": "dz",
  "Angola": "ao",
  "Benin": "bj",
  "Botswana": "bw",
  "Burkina Faso": "bf",
  "Burundi": "bi",
  "Cabo Verde": "cv",
  "Cameroon": "cm",
  "Central African Republic": "cf",
  "Chad": "td",
  "Comoros": "km",
  "Congo (Brazzaville)": "cg",
  "Congo (Kinshasa)": "cd",
  "Djibouti": "dj",
  "Egypt": "eg",
  "Equatorial Guinea": "gq",
  "Eritrea": "er",
  "Eswatini": "sz",
  "Ethiopia": "et",
  "Gabon": "ga",
  "Gambia": "gm",
  "Ghana": "gh",
  "Guinea": "gn",
  "Guinea-Bissau": "gw",
  "Ivory Coast (Côte d'Ivoire)": "ci",
  "Ivory Coast": "ci",
  "Kenya": "ke",
  "Lesotho": "ls",
  "Liberia": "lr",
  "Libya": "ly",
  "Madagascar": "mg",
  "Malawi": "mw",
  "Mali": "ml",
  "Mauritania": "mr",
  "Mauritius": "mu",
  "Morocco": "ma",
  "Mozambique": "mz",
  "Namibia": "na",
  "Niger": "ne",
  "Nigeria": "ng",
  "Rwanda": "rw",
  "São Tomé and Príncipe": "st",
  "Senegal": "sn",
  "Seychelles": "sc",
  "Sierra Leone": "sl",
  "Somalia": "so",
  "South Africa": "za",
  "South Sudan": "ss",
  "Sudan": "sd",
  "Tanzania": "tz",
  "Togo": "tg",
  "Tunisia": "tn",
  "Uganda": "ug",
  "Zambia": "zm",
  "Zimbabwe": "zw",

  // Asia
  "Afghanistan": "af",
  "Bahrain": "bh",
  "Bangladesh": "bd",
  "Bhutan": "bt",
  "Brunei": "bn",
  "Cambodia": "kh",
  "China": "cn",
  "India": "in",
  "Indonesia": "id",
  "Iran": "ir",
  "Iraq": "iq",
  "Israel": "il",
  "Japan": "jp",
  "Jordan": "jo",
  "Kuwait": "kw",
  "Kyrgyzstan": "kg",
  "Laos": "la",
  "Lebanon": "lb",
  "Malaysia": "my",
  "Maldives": "mv",
  "Mongolia": "mn",
  "Myanmar (Burma)": "mm",
  "Myanmar": "mm",
  "Nepal": "np",
  "North Korea": "kp",
  "Oman": "om",
  "Pakistan": "pk",
  "Palestine": "ps",
  "Philippines": "ph",
  "Qatar": "qa",
  "Saudi Arabia": "sa",
  "Singapore": "sg",
  "South Korea": "kr",
  "Sri Lanka": "lk",
  "Syria": "sy",
  "Taiwan": "tw",
  "Tajikistan": "tj",
  "Thailand": "th",
  "Timor-Leste": "tl",
  "Turkmenistan": "tm",
  "United Arab Emirates": "ae",
  "UAE": "ae",
  "Uzbekistan": "uz",
  "Vietnam": "vn",
  "Yemen": "ye",

  // Oceania
  "Australia": "au",
  "Fiji": "fj",
  "Kiribati": "ki",
  "Marshall Islands": "mh",
  "Micronesia": "fm",
  "Nauru": "nr",
  "New Zealand": "nz",
  "Palau": "pw",
  "Papua New Guinea": "pg",
  "Samoa": "ws",
  "Solomon Islands": "sb",
  "Tonga": "to",
  "Tuvalu": "tv",
  "Vanuatu": "vu"
};

/**
 * Get country code from country name
 * @param {string} countryName - The full country name
 * @returns {string|null} - The ISO country code or null if not found
 */
function getCountryCode(countryName) {
  if (!countryName) return null;
  
  // Clean the country name and try direct lookup
  const cleanName = countryName.trim();
  let code = countryMapping[cleanName];
  
  if (code) return code;
  
  // Try case-insensitive lookup
  const lowerName = cleanName.toLowerCase();
  for (const [name, countryCode] of Object.entries(countryMapping)) {
    if (name.toLowerCase() === lowerName) {
      return countryCode;
    }
  }
  
  // Try partial matching for common variations
  for (const [name, countryCode] of Object.entries(countryMapping)) {
    if (name.toLowerCase().includes(lowerName) || lowerName.includes(name.toLowerCase())) {
      return countryCode;
    }
  }
  
  return null;
}

/**
 * Get flag URL for a country
 * @param {string} countryName - The country name
 * @param {string} size - The flag size ('w20', 'w40', 'w80', 'w160', 'w320')
 * @param {string} format - The flag format ('png', 'svg')
 * @returns {string|null} - The flag URL or null if country not found
 */
function getFlagUrl(countryName, size = 'w40', format = 'svg') {
  const code = getCountryCode(countryName);
  if (!code) return null;
  
  // Using flagcdn.com - a reliable flag CDN service
  if (format === 'svg') {
    return `https://flagcdn.com/${code}.svg`;
  } else {
    return `https://flagcdn.com/${size}/${code}.${format}`;
  }
}

/**
 * Get complete country information
 * @param {string} countryName - The country name
 * @returns {object} - Country information with code and flag URLs
 */
function getCountryInfo(countryName) {
  const code = getCountryCode(countryName);
  
  return {
    name: countryName,
    code: code,
    flag: getFlagUrl(countryName, 'w40', 'svg'),
    flagPng: getFlagUrl(countryName, 'w40', 'png'),
    flagSizes: {
      small: getFlagUrl(countryName, 'w20', 'svg'),
      medium: getFlagUrl(countryName, 'w40', 'svg'),
      large: getFlagUrl(countryName, 'w80', 'svg'),
      xlarge: getFlagUrl(countryName, 'w160', 'svg')
    }
  };
}

module.exports = {
  countryMapping,
  getCountryCode,
  getFlagUrl,
  getCountryInfo
}; 