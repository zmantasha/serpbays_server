'use strict';

/**
 * vip-settings service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::vip-settings.vip-settings', ({ strapi }) => ({
  /**
   * Get VIP settings, creating defaults if none exist
   * Returns normalized camelCase keys regardless of DB query method
   */
  async getSettings() {
    let settings = await strapi.db.query('api::vip-settings.vip-settings').findOne({});

    if (!settings) {
      settings = await strapi.entityService.create('api::vip-settings.vip-settings', {
        data: {
          discountPercentage: 0,
          depositBonusPercentage: 0,
          depositBonusMinAmount: 1000,
          depositBonusMaxCap: null,
          canDownloadMarketplace: false,
          downloadMaxItems: 500,
          benefits: {},
        },
      });
    }

    // Normalize snake_case DB columns to camelCase for consistent access
    // strapi.db.query returns raw DB columns (snake_case), while entityService returns camelCase
    return {
      ...settings,
      discountPercentage: settings.discountPercentage ?? settings.discount_percentage,
      depositBonusPercentage: settings.depositBonusPercentage ?? settings.deposit_bonus_percentage,
      depositBonusMinAmount: settings.depositBonusMinAmount ?? settings.deposit_bonus_min_amount,
      depositBonusMaxCap: settings.depositBonusMaxCap ?? settings.deposit_bonus_max_cap,
      canDownloadMarketplace: settings.canDownloadMarketplace ?? settings.can_download_marketplace,
      downloadMaxItems: settings.downloadMaxItems ?? settings.download_max_items,
      guestPostDiscount: settings.guestPostDiscount ?? settings.guest_post_discount,
      linkInsertionDiscount: settings.linkInsertionDiscount ?? settings.link_insertion_discount,
      gpCbdDiscount: settings.gpCbdDiscount ?? settings.gp_cbd_discount,
      gpCasinoDiscount: settings.gpCasinoDiscount ?? settings.gp_casino_discount,
      gpCryptoDiscount: settings.gpCryptoDiscount ?? settings.gp_crypto_discount,
      gpDatingDiscount: settings.gpDatingDiscount ?? settings.gp_dating_discount,
      liCbdDiscount: settings.liCbdDiscount ?? settings.li_cbd_discount,
      liCasinoDiscount: settings.liCasinoDiscount ?? settings.li_casino_discount,
      liCryptoDiscount: settings.liCryptoDiscount ?? settings.li_crypto_discount,
      liDatingDiscount: settings.liDatingDiscount ?? settings.li_dating_discount,
      depositBonusTiers: (() => {
        let tiers = settings.depositBonusTiers ?? settings.deposit_bonus_tiers ?? [];
        // SQLite may store JSON as string — parse if needed
        if (typeof tiers === 'string') {
          try { tiers = JSON.parse(tiers); } catch { tiers = []; }
        }
        return Array.isArray(tiers) ? tiers : [];
      })(),
    };
  },

  /**
   * Calculate VIP deposit bonus based on tier-matching logic.
   * Shared across all payment gateway webhooks (Stripe, PayPal, Razorpay).
   *
   * @param {number} transactionAmount - The deposit amount in USD
   * @param {object} vipSettings - The normalized VIP settings object
   * @returns {{ bonusAmount: number, tier: object } | null}
   */
  calculateVipBonus(transactionAmount, vipSettings) {
    const tiers = vipSettings.depositBonusTiers || [];

    // Multi-tier matching: find the highest-minAmount tier the deposit qualifies for
    if (tiers.length > 0) {
      const sorted = [...tiers].sort((a, b) => b.minAmount - a.minAmount);
      const matchedTier = sorted.find(t => transactionAmount >= t.minAmount && t.value > 0);

      if (matchedTier) {
        let bonusAmount;
        if (matchedTier.type === 'fixed') {
          bonusAmount = matchedTier.value;
        } else {
          // percentage
          bonusAmount = transactionAmount * (matchedTier.value / 100);
          if (matchedTier.maxCap > 0 && bonusAmount > matchedTier.maxCap) {
            bonusAmount = matchedTier.maxCap;
          }
        }
        return { bonusAmount, tier: matchedTier };
      }
    }

    // Fallback to legacy single-tier fields for backward compatibility
    const pct = parseFloat(vipSettings.depositBonusPercentage || 0);
    const min = parseFloat(vipSettings.depositBonusMinAmount || 0);
    if (pct > 0 && transactionAmount >= min) {
      let bonusAmount = transactionAmount * (pct / 100);
      const cap = parseFloat(vipSettings.depositBonusMaxCap || 0);
      if (cap > 0 && bonusAmount > cap) {
        bonusAmount = cap;
      }
      return { bonusAmount, tier: { type: 'percentage', value: pct, minAmount: min, maxCap: cap } };
    }

    return null;
  },
}));
