'use strict';

/**
 * The category list a publisher may choose from. Mirrors AVAILABLE_CATEGORIES
 * in the client (app/(dashboard)/marketplace/constants/categories.ts) — keep
 * the two in step.
 *
 * 2026-09-29: added because `category` was free text on the wire. The dropdown
 * only ever offered these 50, but nothing rejected anything else, so the column
 * drifted to 149 distinct labels — the same category spelled several ways
 * ("News & Media" / "News&Media"), plus typos ("shoping", "Tatoo & Beauty").
 * A buyer filtering on "News & Media" missed 3,485 listings because of it.
 */
const CANONICAL_CATEGORIES = [
  'Agriculture', 'Animals & Pets', 'Arms and ammunition', 'Arts & Entertainment', 'Automobiles',
  'Beauty', 'Blogging', 'Business', 'Career & Employment', 'Computer & Electronics',
  'Coupons Offers & Cashback', 'Cryptocurrency', 'Digital Marketing', 'Ecommerce', 'Education',
  'Environment', 'Family', 'Fashion & Lifestyle', 'Finance', 'Food & Drink', 'Games', 'General',
  'Gift', 'Health & Fitness', 'Home & Garden', 'Humor', 'Internet & Telecom', 'Law & Government',
  'Leisure & Hobbies', 'Magazine', 'Manufacturing', 'Marketing & Advertising', 'Music',
  'News & Media', 'Photography', 'Politics', 'Quotes', 'Real estate', 'Region', 'Reviews',
  'SaaS', 'Science', 'Shopping', 'Spanish', 'Sports', 'Sprituality', 'Technology', 'Travelling',
  'Web development', 'Wedding',
];

// Case/space/& differences are the publisher's UI, not their intent, so a value
// that only differs that way is corrected rather than rejected.
const key = (v) => String(v == null ? '' : v).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const BY_KEY = new Map(CANONICAL_CATEGORIES.map((c) => [key(c), c]));

/**
 * @returns {{ ok: true, value: string[] } | { ok: false, invalid: string[] }}
 */
function normaliseCategories(input) {
  if (input === undefined || input === null) return { ok: true, value: input };

  const list = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [input];

  const out = [];
  const invalid = [];
  for (const raw of list) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    const match = BY_KEY.get(key(trimmed));
    if (!match) invalid.push(trimmed);
    else if (!out.includes(match)) out.push(match);   // canonical spelling, de-duplicated
  }

  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, value: out };
}

module.exports = { CANONICAL_CATEGORIES, normaliseCategories };
