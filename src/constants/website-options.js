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
  validateValue,
  validateValues,
};
