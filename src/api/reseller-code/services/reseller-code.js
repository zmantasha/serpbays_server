'use strict';

/**
 * reseller-code service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::reseller-code.reseller-code', ({ strapi }) => ({
  
  /**
   * Generate a random reseller code
   */
  generateCode(length = 12) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  },

  /**
   * Create a new reseller code
   */
  async createResellerCode(data) {
    try {
      // Generate code if not provided
      if (!data.code) {
        let code;
        let isUnique = false;
        let attempts = 0;
        
        while (!isUnique && attempts < 10) {
          code = this.generateCode();
          const existing = await strapi.entityService.findMany('api::reseller-code.reseller-code', {
            filters: { code }
          });
          isUnique = !existing || existing.length === 0;
          attempts++;
        }
        
        if (!isUnique) {
          throw new Error('Could not generate unique code');
        }
        
        data.code = code;
      }

      const resellerCode = await strapi.entityService.create('api::reseller-code.reseller-code', {
        data: {
          ...data,
          usedCount: 0
        }
      });

      return resellerCode;
    } catch (error) {
      throw new Error(`Failed to create reseller code: ${error.message}`);
    }
  },

  /**
   * Validate if a code can be used
   */
  async validateCode(code) {
    try {
      const resellerCode = await strapi.entityService.findMany('api::reseller-code.reseller-code', {
        filters: {
          code: code,
          isActive: true
        }
      });

      if (!resellerCode || resellerCode.length === 0) {
        return { valid: false, reason: 'Code not found or inactive' };
      }

      const codeData = resellerCode[0];

      // Check expiration
      if (codeData.expiresAt && new Date(codeData.expiresAt) < new Date()) {
        return { valid: false, reason: 'Code has expired' };
      }

      // Check usage limit
      if (codeData.usageLimit !== null && codeData.usedCount >= codeData.usageLimit) {
        return { valid: false, reason: 'Usage limit exceeded' };
      }

      return { valid: true, codeData };
    } catch (error) {
      throw new Error(`Failed to validate code: ${error.message}`);
    }
  },

  /**
   * Use a reseller code (increment counter)
   */
  async useCode(code, userId) {
    try {
      const validation = await this.validateCode(code);
      
      if (!validation.valid) {
        throw new Error(validation.reason);
      }

      const codeData = validation.codeData;

      // Update usage count
      await strapi.entityService.update('api::reseller-code.reseller-code', codeData.id, {
        data: {
          usedCount: codeData.usedCount + 1,
          lastUsedAt: new Date().toISOString(),
          lastUsedBy: userId
        }
      });

      return {
        success: true,
        usedCount: codeData.usedCount + 1,
        remainingUses: codeData.usageLimit ? (codeData.usageLimit - codeData.usedCount - 1) : null
      };
    } catch (error) {
      throw new Error(`Failed to use code: ${error.message}`);
    }
  }

}));
