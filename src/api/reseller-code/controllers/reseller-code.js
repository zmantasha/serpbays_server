'use strict';

/**
 * reseller-code controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::reseller-code.reseller-code', ({ strapi }) => ({
  
  /**
   * Validate a reseller code
   * GET /api/reseller-codes/validate/:code
   */
  async validateCode(ctx) {
    try {
      const { code } = ctx.params;
      
      if (!code) {
        return ctx.badRequest('Code is required');
      }

      // Find the reseller code
      const resellerCode = await strapi.entityService.findMany('api::reseller-code.reseller-code', {
        filters: {
          code: code,
          isActive: true
        },
        populate: ['assignedTo']
      });

      if (!resellerCode || resellerCode.length === 0) {
        return ctx.send({
          valid: false,
          message: 'Invalid or inactive code'
        });
      }

      const codeData = resellerCode[0];

      // Check if code has expired
      if (codeData.expiresAt && new Date(codeData.expiresAt) < new Date()) {
        return ctx.send({
          valid: false,
          message: 'Code has expired'
        });
      }

      // Check usage limit
      if (codeData.usageLimit !== null && codeData.usedCount >= codeData.usageLimit) {
        return ctx.send({
          valid: false,
          message: 'Code usage limit exceeded'
        });
      }

      // Code is valid
      return ctx.send({
        valid: true,
        message: 'Valid code',
        data: {
          id: codeData.id,
          assignedTo: codeData.assignedToName || (codeData.assignedTo ? codeData.assignedTo.username : 'Unknown'),
          usageLimit: codeData.usageLimit,
          usedCount: codeData.usedCount,
          remainingUses: codeData.usageLimit ? (codeData.usageLimit - codeData.usedCount) : null
        }
      });

    } catch (error) {
      console.error('Error validating reseller code:', error);
      return ctx.internalServerError('Error validating code');
    }
  },

  /**
   * Use a reseller code (increment usage count)
   * POST /api/reseller-codes/use/:code
   */
  async useCode(ctx) {
    try {
      const { code } = ctx.params;
      const user = ctx.state.user;

      if (!code) {
        return ctx.badRequest('Code is required');
      }

      if (!user) {
        return ctx.unauthorized('User not authenticated');
      }

      // Find the reseller code
      const resellerCode = await strapi.entityService.findMany('api::reseller-code.reseller-code', {
        filters: {
          code: code,
          isActive: true
        }
      });

      if (!resellerCode || resellerCode.length === 0) {
        return ctx.badRequest('Invalid or inactive code');
      }

      const codeData = resellerCode[0];

      // Check if code has expired
      if (codeData.expiresAt && new Date(codeData.expiresAt) < new Date()) {
        return ctx.badRequest('Code has expired');
      }

      // Check usage limit
      if (codeData.usageLimit !== null && codeData.usedCount >= codeData.usageLimit) {
        return ctx.badRequest('Code usage limit exceeded');
      }

      // Update usage count
      await strapi.entityService.update('api::reseller-code.reseller-code', codeData.id, {
        data: {
          usedCount: codeData.usedCount + 1,
          lastUsedAt: new Date().toISOString(),
          lastUsedBy: user.id
        }
      });

      return ctx.send({
        success: true,
        message: 'Code used successfully',
        data: {
          usedCount: codeData.usedCount + 1,
          remainingUses: codeData.usageLimit ? (codeData.usageLimit - codeData.usedCount - 1) : null
        }
      });

    } catch (error) {
      console.error('Error using reseller code:', error);
      return ctx.internalServerError('Error using code');
    }
  },

  /**
   * Get usage statistics for a reseller code
   * GET /api/reseller-codes/stats/:code
   */
  async getCodeStats(ctx) {
    try {
      const { code } = ctx.params;

      if (!code) {
        return ctx.badRequest('Code is required');
      }

      // Find the reseller code with related websites
      const resellerCode = await strapi.entityService.findMany('api::reseller-code.reseller-code', {
        filters: {
          code: code
        },
        populate: ['assignedTo']
      });

      if (!resellerCode || resellerCode.length === 0) {
        return ctx.notFound('Code not found');
      }

      const codeData = resellerCode[0];

      // Get websites added with this code
      const websites = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters: {
          resellerCode: code
        },
        fields: ['id', 'url', 'submissionStatus', 'createdAt']
      });

      return ctx.send({
        code: codeData.code,
        assignedTo: codeData.assignedToName || (codeData.assignedTo ? codeData.assignedTo.username : 'Unknown'),
        isActive: codeData.isActive,
        usageLimit: codeData.usageLimit,
        usedCount: codeData.usedCount,
        remainingUses: codeData.usageLimit ? (codeData.usageLimit - codeData.usedCount) : null,
        expiresAt: codeData.expiresAt,
        lastUsedAt: codeData.lastUsedAt,
        websitesAdded: websites.length,
        websites: websites
      });

    } catch (error) {
      console.error('Error getting code stats:', error);
      return ctx.internalServerError('Error getting code statistics');
    }
  }

}));
