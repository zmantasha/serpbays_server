'use strict';

/**
 * vip-settings service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::vip-settings.vip-settings', ({ strapi }) => ({
  /**
   * Get VIP settings, creating defaults if none exist
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

    return settings;
  },
}));
