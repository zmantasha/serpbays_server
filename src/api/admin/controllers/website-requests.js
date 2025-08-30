'use strict';

/**
 * Admin Website Requests Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::website-request.website-request', ({ strapi }) => ({

  /**
   * Get all website requests with pagination and filters for admin panel
   */
  async find(ctx) {
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
          { specificDomains: { $containsi: search } },
          { category: { $containsi: search } },
          { additionalRequirements: { $containsi: search } },
          { userEmail: { $containsi: search } }
        ];
      }

      // Status filter
      if (status) {
        filters.status = status;
      }

      // Category filter
      if (category) {
        filters.category = category;
      }

      // User filter
      if (userId) {
        filters.userEmail = userId;
      }

      // Get website requests with pagination
      const websiteRequests = await strapi.entityService.findMany('api::website-request.website-request', {
        filters,
        sort,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize)
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::website-request.website-request').count({ where: filters });

      ctx.send({
        data: websiteRequests,
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
      console.error('[ADMIN WEBSITE REQUESTS FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch website requests');
    }
  },

  /**
   * Get single website request with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;

      const websiteRequest = await strapi.entityService.findOne('api::website-request.website-request', id);

      if (!websiteRequest) {
        return ctx.notFound('Website request not found');
      }

      ctx.send({
        data: websiteRequest
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE REQUEST FIND ONE ERROR]', error);
      return ctx.internalServerError('Failed to fetch website request details');
    }
  },

  /**
   * Approve website request (admin action)
   */
  async approve(ctx) {
    try {
      const { id } = ctx.params;
      const { adminNotes } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} approving website request ${id}`);

      // Get website request details
      const websiteRequest = await strapi.entityService.findOne('api::website-request.website-request', id);

      if (!websiteRequest) {
        return ctx.notFound('Website request not found');
      }

      if (websiteRequest.status !== 'pending') {
        return ctx.badRequest('Website request has already been processed');
      }

      // Update website request
      const updatedRequest = await strapi.entityService.update('api::website-request.website-request', id, {
        data: { 
          status: 'approved',
          adminNotes,
          reviewedAt: new Date(),
          reviewedBy: ctx.state.user.id
        }
      });

      // Create a new website entry in the publisher-website collection
      await strapi.entityService.create('api::publisher-website.publisher-website', {
        data: {
          domain: websiteRequest.specificDomains || 'example.com', // Use specificDomains or fallback
          title: websiteRequest.category || 'Website Request',
          description: websiteRequest.additionalRequirements || 'Approved website request',
          category: websiteRequest.category || 'General',
          status: 'active',
          publisherEmail: websiteRequest.userEmail, // Use userEmail instead of publisher.email
          da: websiteRequest.minDA || 0,
          traffic: websiteRequest.minTraffic || '0',
          addedDate: new Date(),
          publishedAt: new Date()
        }
      });

      ctx.send({
        data: updatedRequest
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE REQUEST APPROVE ERROR]', error);
      return ctx.internalServerError('Failed to approve website request');
    }
  },

  /**
   * Reject website request (admin action)
   */
  async reject(ctx) {
    try {
      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} rejecting website request ${id}. Reason: ${reason}`);

      // Get website request details
      const websiteRequest = await strapi.entityService.findOne('api::website-request.website-request', id);

      if (!websiteRequest) {
        return ctx.notFound('Website request not found');
      }

      if (websiteRequest.status !== 'pending') {
        return ctx.badRequest('Website request has already been processed');
      }

      // Update website request
      const updatedRequest = await strapi.entityService.update('api::website-request.website-request', id, {
        data: { 
          status: 'rejected',
          adminNotes: reason,
          reviewedAt: new Date(),
          reviewedBy: ctx.state.user.id
        }
      });

      ctx.send({
        data: updatedRequest
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE REQUEST REJECT ERROR]', error);
      return ctx.internalServerError('Failed to reject website request');
    }
  },

  /**
   * Get website request statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      const total = await strapi.db.query('api::website-request.website-request').count();
      const pending = await strapi.db.query('api::website-request.website-request').count({
        where: { status: 'pending' }
      });
      const underReview = await strapi.db.query('api::website-request.website-request').count({
        where: { status: 'under_review' }
      });
      const approved = await strapi.db.query('api::website-request.website-request').count({
        where: { status: 'approved' }
      });
      const rejected = await strapi.db.query('api::website-request.website-request').count({
        where: { status: 'rejected' }
      });

      ctx.send({
        totalRequests: total,
        pending,
        underReview,
        approved,
        rejected
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE REQUEST STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch website request statistics');
    }
  },

  /**
   * Bulk process website requests (admin action)
   */
  async bulkProcess(ctx) {
    try {
      const { requestIds, action, notes } = ctx.request.body;

      if (!Array.isArray(requestIds) || requestIds.length === 0) {
        return ctx.badRequest('No request IDs provided');
      }

      if (!['approve', 'reject'].includes(action)) {
        return ctx.badRequest('Invalid action. Must be "approve" or "reject"');
      }

      const results = [];

      for (const requestId of requestIds) {
        try {
          if (action === 'approve') {
            await this.approve({
              params: { id: requestId },
              request: { body: { adminNotes: notes } },
              state: ctx.state,
              send: () => {} // Mock send function
            });
          } else {
            await this.reject({
              params: { id: requestId },
              request: { body: { reason: notes } },
              state: ctx.state,
              send: () => {} // Mock send function
            });
          }
          results.push({ id: requestId, status: 'success' });
        } catch (error) {
          results.push({ id: requestId, status: 'error', message: error.message });
        }
      }

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} bulk ${action} ${requestIds.length} website requests`);

      ctx.send({
        message: `Bulk ${action} completed`,
        results
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE REQUEST BULK PROCESS ERROR]', error);
      return ctx.internalServerError('Failed to process bulk website request action');
    }
  }

})); 