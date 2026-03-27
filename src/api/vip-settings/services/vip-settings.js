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
    };
  },
}));
