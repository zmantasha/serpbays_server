'use strict';

/**
 * Admin VIP Settings Controller
 */

module.exports = {
  /**
   * GET /api/admin/vip-settings
   * Returns the current VIP settings
   */
  async find(ctx) {
    try {
      const settings = await strapi.service('api::vip-settings.vip-settings').getSettings();
      ctx.send({ data: settings });
    } catch (error) {
      console.error('[ADMIN] Error fetching VIP settings:', error);
      ctx.throw(500, 'Failed to fetch VIP settings');
    }
  },

  /**
   * PUT /api/admin/vip-settings
   * Updates VIP settings
   */
  async update(ctx) {
    try {
      const data = ctx.request.body;

      // Validate discountPercentage
      if (data.discountPercentage !== undefined) {
        const pct = parseFloat(data.discountPercentage);
        if (isNaN(pct) || pct < 0 || pct > 100) {
          return ctx.badRequest('discountPercentage must be between 0 and 100');
        }
        data.discountPercentage = pct;
      }

      // Validate depositBonusPercentage
      if (data.depositBonusPercentage !== undefined) {
        const pct = parseFloat(data.depositBonusPercentage);
        if (isNaN(pct) || pct < 0 || pct > 100) {
          return ctx.badRequest('depositBonusPercentage must be between 0 and 100');
        }
        data.depositBonusPercentage = pct;
      }

      // Validate depositBonusMinAmount
      if (data.depositBonusMinAmount !== undefined) {
        const amt = parseFloat(data.depositBonusMinAmount);
        if (isNaN(amt) || amt < 0) {
          return ctx.badRequest('depositBonusMinAmount must be >= 0');
        }
        data.depositBonusMinAmount = amt;
      }

      // Validate depositBonusTiers array
      if (data.depositBonusTiers !== undefined) {
        if (!Array.isArray(data.depositBonusTiers)) {
          return ctx.badRequest('depositBonusTiers must be an array');
        }
        for (let i = 0; i < data.depositBonusTiers.length; i++) {
          const tier = data.depositBonusTiers[i];
          if (!tier.minAmount || parseFloat(tier.minAmount) <= 0) {
            return ctx.badRequest(`Tier ${i + 1}: minAmount must be greater than 0`);
          }
          if (!['percentage', 'fixed'].includes(tier.type)) {
            return ctx.badRequest(`Tier ${i + 1}: type must be 'percentage' or 'fixed'`);
          }
          if (!tier.value || parseFloat(tier.value) <= 0) {
            return ctx.badRequest(`Tier ${i + 1}: value must be greater than 0`);
          }
          if (tier.type === 'percentage' && parseFloat(tier.value) > 100) {
            return ctx.badRequest(`Tier ${i + 1}: percentage value cannot exceed 100`);
          }
          // Normalize numeric fields
          data.depositBonusTiers[i] = {
            minAmount: parseFloat(tier.minAmount),
            type: tier.type,
            value: parseFloat(tier.value),
            maxCap: tier.maxCap ? parseFloat(tier.maxCap) : null,
          };
        }
        // Sort by minAmount ascending for consistent display
        data.depositBonusTiers.sort((a, b) => a.minAmount - b.minAmount);
      }

      // Get existing settings (creates defaults if none)
      const existing = await strapi.service('api::vip-settings.vip-settings').getSettings();

      // Update
      const updated = await strapi.entityService.update('api::vip-settings.vip-settings', existing.id, {
        data,
      });

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} updated VIP settings:`, {
        discountPercentage: updated.discountPercentage,
        depositBonusPercentage: updated.depositBonusPercentage,
      });

      ctx.send({ data: updated });
    } catch (error) {
      console.error('[ADMIN] Error updating VIP settings:', error);
      ctx.throw(500, 'Failed to update VIP settings');
    }
  },
};
