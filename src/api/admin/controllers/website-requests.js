'use strict';

/**
 * Admin Website Requests Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::website-request.website-request', ({ strapi }) => ({

  /**
   * Get all website requests with pagination and filters for admin panel
   */
  async getWebsiteRequests(ctx) {
    try {
      const { 
        page = 1, 
        pageSize = 20, 
        sort = 'createdAt:desc',
        search = '',
        status = '',
        category = '',
        userId = ''
      } = ctx.query;

      // Build filters
      const filters = {};
      
      // Search filter
      if (search) {
        filters.$or = [
          { title: { $containsi: search } },
          { domain: { $containsi: search } },
          { userEmail: { $containsi: search } }
        ];
      }

      // Status filter
      if (status && status !== 'all') {
        filters.status = status;
      }

      // Category filter
      if (category && category !== 'all') {
        filters.category = category;
      }

      // User ID filter
      if (userId) {
        filters.userId = userId;
      }

      const response = await strapi.entityService.findMany('api::website-request.website-request', {
        filters,
        sort,
        populate: {
          user: {
            fields: ['id', 'username', 'email']
          }
        },
        start: (page - 1) * pageSize,
        limit: pageSize,
      });

      // Get total count for pagination
      const total = await strapi.entityService.count('api::website-request.website-request', {
        filters,
      });

      return {
        data: response,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize),
          total,
          totalPages: Math.ceil(total / pageSize)
        }
      };
    } catch (error) {
      console.error('Admin getWebsiteRequests error:', error);
      return ctx.badRequest('Failed to fetch website requests', { error: error.message });
    }
  },

  /**
   * Get website request statistics for admin dashboard
   */
  async getWebsiteRequestStats(ctx) {
    try {
      const [total, pending, underReview, approved, rejected] = await Promise.all([
        strapi.entityService.count('api::website-request.website-request', {}),
        strapi.entityService.count('api::website-request.website-request', { 
          filters: { status: 'pending' } 
        }),
        strapi.entityService.count('api::website-request.website-request', { 
          filters: { status: 'under_review' } 
        }),
        strapi.entityService.count('api::website-request.website-request', { 
          filters: { status: 'approved' } 
        }),
        strapi.entityService.count('api::website-request.website-request', { 
          filters: { status: 'rejected' } 
        })
      ]);

      return {
        totalRequests: total,
        pending,
        underReview,
        approved,
        rejected
      };
    } catch (error) {
      console.error('Admin getWebsiteRequestStats error:', error);
      return ctx.badRequest('Failed to fetch website request stats', { error: error.message });
    }
  },

  /**
   * Get a specific website request by ID
   */
  async getWebsiteRequestById(ctx) {
    try {
      const { id } = ctx.params;

      const websiteRequest = await strapi.entityService.findOne('api::website-request.website-request', id, {
        populate: {
          user: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          }
        }
      });

      if (!websiteRequest) {
        return ctx.notFound('Website request not found');
      }

      return { data: websiteRequest };
    } catch (error) {
      console.error('Admin getWebsiteRequestById error:', error);
      return ctx.badRequest('Failed to fetch website request', { error: error.message });
    }
  },

  /**
   * Approve a website request
   */
  async approveWebsiteRequest(ctx) {
    try {
      const { id } = ctx.params;
      const { adminNotes } = ctx.request.body;

      const updatedRequest = await strapi.entityService.update('api::website-request.website-request', id, {
        data: {
          status: 'approved',
          adminNotes: adminNotes || '',
          approvedAt: new Date(),
          approvedBy: ctx.state.user.id
        },
        populate: {
          user: {
            fields: ['id', 'username', 'email']
          }
        }
      });

      if (!updatedRequest) {
        return ctx.notFound('Website request not found');
      }

      // TODO: Send email notification to user about approval
      console.log(`Website request ${id} approved by admin ${ctx.state.user.id}`);

      return updatedRequest;
    } catch (error) {
      console.error('Admin approveWebsiteRequest error:', error);
      return ctx.badRequest('Failed to approve website request', { error: error.message });
    }
  },

  /**
   * Reject a website request
   */
  async rejectWebsiteRequest(ctx) {
    try {
      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      if (!reason) {
        return ctx.badRequest('Rejection reason is required');
      }

      const updatedRequest = await strapi.entityService.update('api::website-request.website-request', id, {
        data: {
          status: 'rejected',
          rejectionReason: reason,
          rejectedAt: new Date(),
          rejectedBy: ctx.state.user.id
        },
        populate: {
          user: {
            fields: ['id', 'username', 'email']
          }
        }
      });

      if (!updatedRequest) {
        return ctx.notFound('Website request not found');
      }

      // TODO: Send email notification to user about rejection
      console.log(`Website request ${id} rejected by admin ${ctx.state.user.id}`);

      return updatedRequest;
    } catch (error) {
      console.error('Admin rejectWebsiteRequest error:', error);
      return ctx.badRequest('Failed to reject website request', { error: error.message });
    }
  },

  /**
   * Bulk process website requests (approve/reject multiple)
   */
  async bulkProcessWebsiteRequests(ctx) {
    try {
      const { requestIds, action, notes } = ctx.request.body;

      if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
        return ctx.badRequest('Request IDs array is required');
      }

      if (!['approve', 'reject'].includes(action)) {
        return ctx.badRequest('Action must be either "approve" or "reject"');
      }

      if (action === 'reject' && !notes) {
        return ctx.badRequest('Rejection reason is required for reject action');
      }

      const updateData = {
        status: action === 'approve' ? 'approved' : 'rejected',
        [`${action}edAt`]: new Date(),
        [`${action}edBy`]: ctx.state.user.id
      };

      if (action === 'approve') {
        updateData.adminNotes = notes || '';
      } else {
        updateData.rejectionReason = notes;
      }

      const results = [];
      
      for (const id of requestIds) {
        try {
          const updated = await strapi.entityService.update('api::website-request.website-request', id, {
            data: updateData,
            populate: {
              user: {
                fields: ['id', 'username', 'email']
              }
            }
          });
          results.push({ id, success: true, data: updated });
        } catch (error) {
          results.push({ id, success: false, error: error.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      console.log(`Bulk ${action} processed: ${successCount} successful, ${failCount} failed`);

      return {
        success: true,
        processed: successCount,
        failed: failCount,
        results
      };
    } catch (error) {
      console.error('Admin bulkProcessWebsiteRequests error:', error);
      return ctx.badRequest('Failed to bulk process website requests', { error: error.message });
    }
  }

}));
