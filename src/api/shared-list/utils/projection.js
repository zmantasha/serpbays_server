'use strict';

/**
 * Helpers shared between the public shared-list controller and the admin
 * controller (e.g. for taking a snapshot we need to project websites with
 * the exact same shape that the public endpoint serves).
 */

const ALLOWED_COLUMNS = new Set([
  'domain', 'da', 'dr', 'traffic', 'category', 'language',
  'articleMinLength', 'backlinkType', 'allowedLinks', 'rules',
  'sponsored', 'price', 'linkValidity', 'noBacklinks', 'tat',
]);

const DEFAULT_VISIBLE_COLUMNS = [
  'domain', 'da', 'dr', 'traffic', 'category', 'language', 'price',
];

function computeDisplayPrice(list, marketplaceRow) {
  const { pricingMode, markupValue = 0, markupType = 'percent', priceOverrides = {} } = list;
  if (pricingMode === 'hidden') return null;

  const base = Number(marketplaceRow.price ?? 0);

  if (pricingMode === 'custom') {
    const override = priceOverrides?.[String(marketplaceRow.id)];
    if (override !== undefined && override !== null && override !== '') {
      const n = Number(override);
      if (!Number.isNaN(n)) return n;
    }
    return base;
  }

  if (pricingMode === 'markup') {
    const v = Number(markupValue ?? 0);
    if (!Number.isFinite(v) || v === 0) return base;
    if (markupType === 'fixed') return base + v;
    return Math.round(base * (1 + v / 100));
  }

  return base;
}

function projectWebsite(list, mp) {
  return {
    id: mp.id,
    domain: mp.url,
    da: mp.moz_da ?? null,
    dr: mp.ahrefs_dr ?? null,
    traffic: mp.ahrefs_traffic ?? null,
    category: Array.isArray(mp.category) ? mp.category : (mp.category ? [mp.category] : []),
    language: mp.language ?? null,
    articleMinLength: mp.minWordCount ?? null,
    backlinkType: mp.backlinkType ?? null,
    allowedLinks: mp.allowedLinks ?? null,
    rules: mp.guidelines ?? null,
    sponsored: !!mp.sponsored,
    linkValidity: mp.backlinkValidity ?? 'Permanent',
    noBacklinks: mp.noBacklinks ?? null,
    tat: mp.expectedTATHours ?? null,
    price: computeDisplayPrice(list, mp),
  };
}

module.exports = {
  ALLOWED_COLUMNS,
  DEFAULT_VISIBLE_COLUMNS,
  computeDisplayPrice,
  projectWebsite,
};
