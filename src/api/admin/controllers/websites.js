'use strict';

/**
 * Admin Websites Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::publisher-website.publisher-website', ({ strapi }) => ({

  /**
   * Get all websites with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const { 
        page = 1, 
        pageSize = 20, 
        sort = 'createdAt:desc',
        search = '',
        status = '',
        userId = ''
      } = ctx.query;

      // Build filters
      const filters = {};
      
      // Search filter
      if (search) {
        filters.$or = [
          { domain: { $containsi: search } },
          { title: { $containsi: search } },
          { id: { $eq: parseInt(search) || 0 } }
        ];
      }

      // Status filter
      if (status) {
        filters.submissionStatus = status;
      }

      // User filter
      if (userId) {
        filters.$or = [
          { currentPublisherId: userId },
          { originalPublisherId: userId }
        ];
      }

      // Get websites with pagination
      const websites = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters,
        sort,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize)
        },
        populate: {
          currentPublisherId: {
            fields: ['id', 'username', 'email']
          },
          originalPublisherId: {
            fields: ['id', 'username', 'email']
          }
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::publisher-website.publisher-website').count({ where: filters });

      ctx.send({
        data: websites,
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
      console.error('[ADMIN WEBSITES FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch websites');
    }
  },

  /**
   * Get single website with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;

      const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: {
          currentPublisherId: {
            fields: ['id', 'username', 'email']
          },
          originalPublisherId: {
            fields: ['id', 'username', 'email']
          }
        }
      });

      if (!website) {
        return ctx.notFound('Website not found');
      }

      ctx.send({
        data: website
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE FIND ONE ERROR]', error);
      return ctx.internalServerError('Failed to fetch website details');
    }
  },

  /**
   * Approve website (admin action)
   */
  async approve(ctx) {
    try {
      const { id } = ctx.params;
      const { adminNotes } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} approving website ${id}`);

      const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: { 
          submissionStatus: 'approved',
          adminNotes,
          approvedAt: new Date(),
          approvedBy: ctx.state.user.id
        },
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      ctx.send({
        data: updatedWebsite
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE APPROVE ERROR]', error);
      return ctx.internalServerError('Failed to approve website');
    }
  },

  /**
   * Reject website (admin action)
   */
  async reject(ctx) {
    try {
      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} rejecting website ${id}. Reason: ${reason}`);

      const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: { 
          submissionStatus: 'rejected',
          rejectionReason: reason,
          rejectedAt: new Date(),
          rejectedBy: ctx.state.user.id
        },
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      ctx.send({
        data: updatedWebsite
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE REJECT ERROR]', error);
      return ctx.internalServerError('Failed to reject website');
    }
  },

  /**
   * Get website statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      const total = await strapi.db.query('api::publisher-website.publisher-website').count();
      const pending = await strapi.db.query('api::publisher-website.publisher-website').count({
        where: { submissionStatus: 'approval_pending' }
      });
      const approved = await strapi.db.query('api::publisher-website.publisher-website').count({
        where: { submissionStatus: 'approved' }
      });
      const rejected = await strapi.db.query('api::publisher-website.publisher-website').count({
        where: { submissionStatus: 'rejected' }
      });

      // Get new websites this month
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);

      const newThisMonth = await strapi.db.query('api::publisher-website.publisher-website').count({
        where: {
          createdAt: {
            $gte: thisMonth.toISOString()
          }
        }
      });

      ctx.send({
        total,
        pending,
        approved,
        rejected,
        newThisMonth
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch website statistics');
    }
  }

}));
