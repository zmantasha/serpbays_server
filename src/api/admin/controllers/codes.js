'use strict';

/**
 * Admin Codes Controller
 * Handles all code management operations for admin users
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::reseller-code.reseller-code', ({ strapi }) => ({
  
  /**
   * Get all codes with filtering and pagination
   * GET /api/admin/codes
   */
  async find(ctx) {
    try {
      const { page = 1, pageSize = 25, search, type, status, sortBy = 'createdAt', sortOrder = 'desc' } = ctx.query;
      
      let allCodes = [];
      let total = 0;
      
      // Fetch reseller codes
      let resellerFilters = {};
      if (search) {
        resellerFilters.$or = [
          { code: { $containsi: search } },
          { assignedToName: { $containsi: search } },
          { notes: { $containsi: search } }
        ];
      }
      
      if (type && type !== 'all') {
        if (type === 'reseller') {
          resellerFilters.$or = [
            { assignedTo: { $notNull: true } },
            { assignedToName: { $notNull: true } }
          ];
        }
      }
      
      if (status && status !== 'all') {
        if (status === 'active') {
          resellerFilters.isActive = true;
          resellerFilters.$or = [
            { expiresAt: { $gt: new Date().toISOString() } },
            { expiresAt: null }
          ];
        } else if (status === 'expired') {
          resellerFilters.$or = [
            { expiresAt: { $lt: new Date().toISOString() } },
            { isActive: false }
          ];
        } else if (status === 'disabled') {
          resellerFilters.isActive = false;
        }
      }
      
      const resellerCodes = await strapi.entityService.findMany('api::reseller-code.reseller-code', {
        filters: resellerFilters,
        populate: ['assignedTo', 'createdBy', 'lastUsedBy']
      });
      
      // Transform reseller codes
      const transformedResellerCodes = resellerCodes.map(code => ({
        id: `rs_${code.id}`,
        code: code.code,
        type: 'Reseller',
        assignedTo: code.assignedTo ? {
          id: code.assignedTo.id,
          username: code.assignedTo.username,
          email: code.assignedTo.email
        } : null,
        assignedToName: code.assignedToName,
        usageLimit: code.usageLimit,
        usedCount: code.usedCount,
        remainingUses: code.usageLimit ? (code.usageLimit - code.usedCount) : null,
        isActive: code.isActive,
        expiresAt: code.expiresAt,
        notes: code.notes,
        lastUsedAt: code.lastUsedAt,
        lastUsedBy: code.lastUsedBy ? {
          id: code.lastUsedBy.id,
          username: code.lastUsedBy.username,
          email: code.lastUsedBy.email
        } : null,
        createdBy: code.createdBy ? {
          id: code.createdBy.id,
          username: code.createdBy.username
        } : null,
        createdAt: code.createdAt,
        updatedAt: code.updatedAt,
        originalId: code.id,
        originalType: 'reseller-code'
      }));
      
      // Fetch promo codes
      let promoFilters = {};
      if (search) {
        promoFilters.$or = [
          { code: { $containsi: search } },
          { description: { $containsi: search } }
        ];
      }
      
      if (type && type !== 'all') {
        if (type === 'promo') {
          // Only fetch promo codes
        }
      }
      
      if (status && status !== 'all') {
        if (status === 'active') {
          promoFilters.promoStatus = 'active';
          promoFilters.$or = [
            { expiryDate: { $gt: new Date().toISOString() } }
          ];
        } else if (status === 'expired') {
          promoFilters.$or = [
            { expiryDate: { $lt: new Date().toISOString() } },
            { promoStatus: 'inactive' }
          ];
        } else if (status === 'disabled') {
          promoFilters.promoStatus = 'inactive';
        }
      }
      
      const promoCodes = await strapi.entityService.findMany('api::promo-code.promo-code', {
        filters: promoFilters,
        populate: ['redemptions']
      });
      
      // Transform promo codes
      const transformedPromoCodes = promoCodes.map(code => ({
        id: `pc_${code.id}`,
        code: code.code,
        type: 'Promo',
        assignedTo: null,
        assignedToName: null,
        usageLimit: code.maxRedemptions,
        usedCount: code.currentRedemptions,
        remainingUses: code.maxRedemptions ? (code.maxRedemptions - code.currentRedemptions) : null,
        isActive: code.promoStatus === 'active',
        expiresAt: code.expiryDate,
        notes: code.description,
        lastUsedAt: null,
        lastUsedBy: null,
        createdBy: null,
        createdAt: code.createdAt,
        updatedAt: code.updatedAt,
        originalId: code.id,
        originalType: 'promo-code',
        amount: code.amount
      }));
      
      // Fetch voucher codes
      let voucherFilters = {};
      if (search) {
        voucherFilters.$or = [
          { code: { $containsi: search } },
          { description: { $containsi: search } }
        ];
      }
      
      if (type && type !== 'all') {
        if (type === 'voucher') {
          // Only fetch voucher codes
        }
      }
      
      if (status && status !== 'all') {
        if (status === 'active') {
          voucherFilters.voucherStatus = 'active';
          voucherFilters.$or = [
            { expiryDate: { $gt: new Date().toISOString() } }
          ];
        } else if (status === 'expired') {
          voucherFilters.$or = [
            { expiryDate: { $lt: new Date().toISOString() } },
            { voucherStatus: 'inactive' }
          ];
        } else if (status === 'disabled') {
          voucherFilters.voucherStatus = 'inactive';
        } else if (status === 'used') {
          voucherFilters.voucherStatus = 'used';
        }
      }
      
      const voucherCodes = await strapi.entityService.findMany('api::voucher-code.voucher-code', {
        filters: voucherFilters,
        populate: ['usedBy', 'createdBy']
      });
      
      // Transform voucher codes
      const transformedVoucherCodes = voucherCodes.map(code => ({
        id: `vc_${code.id}`,
        code: code.code,
        type: 'Voucher',
        assignedTo: null,
        assignedToName: null,
        usageLimit: 1, // Voucher codes can only be used once
        usedCount: code.voucherStatus === 'used' ? 1 : 0,
        remainingUses: code.voucherStatus === 'used' ? 0 : 1,
        isActive: code.voucherStatus === 'active',
        expiresAt: code.expiryDate,
        notes: code.description,
        lastUsedAt: code.usedAt,
        lastUsedBy: code.usedBy ? {
          id: code.usedBy.id,
          username: code.usedBy.username,
          email: code.usedBy.email
        } : null,
        createdBy: code.createdBy ? {
          id: code.createdBy.id,
          username: code.createdBy.username
        } : null,
        createdAt: code.createdAt,
        updatedAt: code.updatedAt,
        originalId: code.id,
        originalType: 'voucher-code',
        amount: code.amount,
        voucherStatus: code.voucherStatus
      }));
      
      // Combine and filter by type if needed
      if (type === 'reseller') {
        allCodes = transformedResellerCodes;
        total = transformedResellerCodes.length;
      } else if (type === 'promo') {
        allCodes = transformedPromoCodes;
        total = transformedPromoCodes.length;
      } else if (type === 'voucher') {
        allCodes = transformedVoucherCodes;
        total = transformedVoucherCodes.length;
      } else {
        allCodes = [...transformedResellerCodes, ...transformedPromoCodes, ...transformedVoucherCodes];
        total = allCodes.length;
      }
      
      // Apply sorting
      allCodes.sort((a, b) => {
        const aValue = a[sortBy];
        const bValue = b[sortBy];
        
        if (sortOrder === 'desc') {
          return bValue > aValue ? 1 : -1;
        } else {
          return aValue > bValue ? 1 : -1;
        }
      });
      
      // Apply pagination
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const paginatedCodes = allCodes.slice(start, end);
      
      ctx.send({
        data: paginatedCodes,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount: Math.ceil(total / pageSize),
            total
          }
        }
      });
      
    } catch (error) {
      console.error('[ADMIN CODES FIND ERROR]', error);
      ctx.internalServerError('Failed to fetch codes');
    }
  },
  
  /**
   * Get code statistics
   * GET /api/admin/codes/stats
   */
  async getStats(ctx) {
    try {
      // Reseller codes stats
      const totalResellerCodes = await strapi.entityService.count('api::reseller-code.reseller-code');
      const activeResellerCodes = await strapi.entityService.count('api::reseller-code.reseller-code', {
        filters: {
          isActive: true,
          $or: [
            { expiresAt: { $gt: new Date().toISOString() } },
            { expiresAt: null }
          ]
        }
      });
      const expiredResellerCodes = await strapi.entityService.count('api::reseller-code.reseller-code', {
        filters: {
          $or: [
            { expiresAt: { $lt: new Date().toISOString() } },
            { isActive: false }
          ]
        }
      });
      
      // Promo codes stats
      const totalPromoCodes = await strapi.entityService.count('api::promo-code.promo-code');
      const activePromoCodes = await strapi.entityService.count('api::promo-code.promo-code', {
        filters: {
          promoStatus: 'active',
          expiryDate: { $gt: new Date().toISOString() }
        }
      });
      const expiredPromoCodes = await strapi.entityService.count('api::promo-code.promo-code', {
        filters: {
          $or: [
            { expiryDate: { $lt: new Date().toISOString() } },
            { promoStatus: 'inactive' }
          ]
        }
      });
      
      // Voucher codes stats
      const totalVoucherCodes = await strapi.entityService.count('api::voucher-code.voucher-code');
      const activeVoucherCodes = await strapi.entityService.count('api::voucher-code.voucher-code', {
        filters: {
          voucherStatus: 'active',
          expiryDate: { $gt: new Date().toISOString() }
        }
      });
      const usedVoucherCodes = await strapi.entityService.count('api::voucher-code.voucher-code', {
        filters: {
          voucherStatus: 'used'
        }
      });
      const expiredVoucherCodes = await strapi.entityService.count('api::voucher-code.voucher-code', {
        filters: {
          $or: [
            { expiryDate: { $lt: new Date().toISOString() } },
            { voucherStatus: 'inactive' }
          ]
        }
      });
      
      const totalCodes = totalResellerCodes + totalPromoCodes + totalVoucherCodes;
      const activeCodes = activeResellerCodes + activePromoCodes + activeVoucherCodes;
      const expiredCodes = expiredResellerCodes + expiredPromoCodes + expiredVoucherCodes;
      
      ctx.send({
        totalCodes,
        activeCodes,
        expiredCodes,
        resellerCodes: totalResellerCodes,
        promoCodes: totalPromoCodes,
        voucherCodes: totalVoucherCodes,
        usedVoucherCodes,
        generalCodes: 0 // No general codes in current schema
      });
      
    } catch (error) {
      console.error('[ADMIN CODES STATS ERROR]', error);
      ctx.internalServerError('Failed to fetch code statistics');
    }
  },
  
  /**
   * Generate a new code
   * POST /api/admin/codes/generate
   */
  async generateCode(ctx) {
    try {
      const { type, assignedTo, assignedToName, usageLimit, expiresAt, notes, amount, maxRedemptions } = ctx.request.body;
      
      // Validate required fields
      if (!type) {
        return ctx.badRequest('Code type is required');
      }
      
      if (type === 'promo' && !amount) {
        return ctx.badRequest('Amount is required for promo codes');
      }
      
      // Generate unique code
      let code;
      let attempts = 0;
      const maxAttempts = 10;
      
      do {
        if (type === 'reseller') {
          code = 'RS' + Math.random().toString(36).substring(2, 8).toUpperCase();
        } else if (type === 'promo') {
          code = 'PROMO' + Math.random().toString(36).substring(2, 8).toUpperCase();
        } else if (type === 'voucher') {
          code = 'VOUCHER' + Math.random().toString(36).substring(2, 8).toUpperCase();
        } else {
          code = 'GEN' + Math.random().toString(36).substring(2, 8).toUpperCase();
        }
        attempts++;
        
        // Check if code already exists in all collections
        const existingResellerCode = await strapi.entityService.findMany('api::reseller-code.reseller-code', {
          filters: { code }
        });
        const existingPromoCode = await strapi.entityService.findMany('api::promo-code.promo-code', {
          filters: { code }
        });
        const existingVoucherCode = await strapi.entityService.findMany('api::voucher-code.voucher-code', {
          filters: { code }
        });
        
        if (existingResellerCode.length === 0 && existingPromoCode.length === 0 && existingVoucherCode.length === 0) {
          break;
        }
      } while (attempts < maxAttempts);
      
      if (attempts >= maxAttempts) {
        return ctx.internalServerError('Failed to generate unique code after multiple attempts');
      }
      
      let newCode;
      
      if (type === 'promo') {
        // Create promo code
        const promoCodeData = {
          code,
          amount: parseFloat(amount),
          promoStatus: 'active',
          expiryDate: expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // Default 30 days
          maxRedemptions: maxRedemptions || 1,
          currentRedemptions: 0,
          description: notes || 'Promo code'
        };
        
        newCode = await strapi.entityService.create('api::promo-code.promo-code', {
          data: promoCodeData
        });
        
        ctx.send({
          success: true,
          message: 'Promo code generated successfully',
          data: {
            id: `pc_${newCode.id}`,
            code: newCode.code,
            type: 'Promo',
            amount: newCode.amount,
            usageLimit: newCode.maxRedemptions,
            usedCount: newCode.currentRedemptions,
            isActive: newCode.promoStatus === 'active',
            expiresAt: newCode.expiryDate,
            notes: newCode.description,
            createdAt: newCode.createdAt
          }
        });
      } else if (type === 'voucher') {
        // Create voucher code
        const voucherCodeData = {
          code,
          amount: parseFloat(amount),
          voucherStatus: 'active',
          expiryDate: expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // Default 30 days
          description: notes || 'Voucher code'
        };
        
        newCode = await strapi.entityService.create('api::voucher-code.voucher-code', {
          data: voucherCodeData
        });
        
        ctx.send({
          success: true,
          message: 'Voucher code generated successfully',
          data: {
            id: `vc_${newCode.id}`,
            code: newCode.code,
            type: 'Voucher',
            amount: newCode.amount,
            usageLimit: 1, // Voucher codes can only be used once
            usedCount: 0,
            isActive: newCode.voucherStatus === 'active',
            expiresAt: newCode.expiryDate,
            notes: newCode.description,
            createdAt: newCode.createdAt
          }
        });
      } else {
        // Create reseller code
        const resellerCodeData = {
          code,
          assignedTo: assignedTo || null,
          assignedToName: assignedToName || null,
          usageLimit: usageLimit || null,
          usedCount: 0,
          isActive: true,
          expiresAt: expiresAt || null,
          notes: notes || null,
          createdBy: ctx.state.user?.id || null
        };
        
        newCode = await strapi.entityService.create('api::reseller-code.reseller-code', {
          data: resellerCodeData
        });
        
        ctx.send({
          success: true,
          message: 'Reseller code generated successfully',
          data: {
            id: `rs_${newCode.id}`,
            code: newCode.code,
            type: 'Reseller',
            assignedTo: newCode.assignedTo,
            assignedToName: newCode.assignedToName,
            usageLimit: newCode.usageLimit,
            usedCount: newCode.usedCount,
            isActive: newCode.isActive,
            expiresAt: newCode.expiresAt,
            notes: newCode.notes,
            createdAt: newCode.createdAt
          }
        });
      }
      
    } catch (error) {
      console.error('[ADMIN CODES GENERATE ERROR]', error);
      ctx.internalServerError('Failed to generate code');
    }
  },
  
  /**
   * Update code status
   * PUT /api/admin/codes/:id/status
   */
  async updateStatus(ctx) {
    try {
      const { id } = ctx.params;
      const { isActive } = ctx.request.body;
      
      if (typeof isActive !== 'boolean') {
        return ctx.badRequest('isActive must be a boolean value');
      }
      
      const updatedCode = await strapi.entityService.update('api::reseller-code.reseller-code', id, {
        data: { isActive }
      });
      
      ctx.send({
        success: true,
        message: `Code ${isActive ? 'activated' : 'deactivated'} successfully`,
        data: {
          id: updatedCode.id,
          code: updatedCode.code,
          isActive: updatedCode.isActive
        }
      });
      
    } catch (error) {
      console.error('[ADMIN CODES UPDATE STATUS ERROR]', error);
      ctx.internalServerError('Failed to update code status');
    }
  },
  
  /**
   * Delete a code
   * DELETE /api/admin/codes/:id
   */
  async deleteCode(ctx) {
    try {
      const { id } = ctx.params;
      
      // Check if code has been used
      const code = await strapi.entityService.findOne('api::reseller-code.reseller-code', id);
      
      if (code.usedCount > 0) {
        return ctx.badRequest('Cannot delete code that has been used. Consider deactivating it instead.');
      }
      
      await strapi.entityService.delete('api::reseller-code.reseller-code', id);
      
      ctx.send({
        success: true,
        message: 'Code deleted successfully'
      });
      
    } catch (error) {
      console.error('[ADMIN CODES DELETE ERROR]', error);
      ctx.internalServerError('Failed to delete code');
    }
  },
  
  /**
   * Bulk generate codes
   * POST /api/admin/codes/bulk-generate
   */
  async bulkGenerateCodes(ctx) {
    try {
      const { count = 1, type, prefix, usageLimit, expiresAt, notes } = ctx.request.body;
      
      if (count < 1 || count > 100) {
        return ctx.badRequest('Count must be between 1 and 100');
      }
      
      const generatedCodes = [];
      
      for (let i = 0; i < count; i++) {
        // Generate unique code
        let code;
        let attempts = 0;
        const maxAttempts = 10;
        
        do {
          if (type === 'reseller') {
            code = (prefix || 'RS') + Math.random().toString(36).substring(2, 8).toUpperCase();
          } else {
            code = (prefix || 'GEN') + Math.random().toString(36).substring(2, 8).toUpperCase();
          }
          attempts++;
          
          // Check if code already exists
          const existingCode = await strapi.entityService.findMany('api::reseller-code.reseller-code', {
            filters: { code }
          });
          
          if (existingCode.length === 0) {
            break;
          }
        } while (attempts < maxAttempts);
        
        if (attempts >= maxAttempts) {
          return ctx.internalServerError(`Failed to generate unique code after multiple attempts for code ${i + 1}`);
        }
        
        // Create the code
        const codeData = {
          code,
          usageLimit: usageLimit || null,
          usedCount: 0,
          isActive: true,
          expiresAt: expiresAt || null,
          notes: notes || null,
          createdBy: ctx.state.user?.id || null
        };
        
        const newCode = await strapi.entityService.create('api::reseller-code.reseller-code', {
          data: codeData
        });
        
        generatedCodes.push({
          id: newCode.id,
          code: newCode.code,
          type: type || 'General',
          usageLimit: newCode.usageLimit,
          usedCount: newCode.usedCount,
          isActive: newCode.isActive,
          expiresAt: newCode.expiresAt,
          notes: newCode.notes,
          createdAt: newCode.createdAt
        });
      }
      
      ctx.send({
        success: true,
        message: `${count} codes generated successfully`,
        data: generatedCodes
      });
      
    } catch (error) {
      console.error('[ADMIN CODES BULK GENERATE ERROR]', error);
      ctx.internalServerError('Failed to bulk generate codes');
    }
  }
}));
