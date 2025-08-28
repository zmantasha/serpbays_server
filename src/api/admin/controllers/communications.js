'use strict';

/**
 * Admin Communications Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::communication.communication', ({ strapi }) => ({

  /**
   * Get all communications with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const { 
        page = 1, 
        pageSize = 20, 
        sort = 'createdAt:desc',
        search = '',
        type = '',
        orderId = '',
        userId = ''
      } = ctx.query;

      // Build filters
      const filters = {};
      
      // Search filter
      if (search) {
        filters.$or = [
          { message: { $containsi: search } },
          { id: { $eq: parseInt(search) || 0 } }
        ];
      }

      // Type filter
      if (type) {
        filters.messageType = type;
      }

      // Order filter
      if (orderId) {
        filters.order = orderId;
      }

      // User filter
      if (userId) {
        filters.sender = userId;
      }

      // Get communications with pagination
      const communications = await strapi.entityService.findMany('api::communication.communication', {
        filters,
        sort,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize)
        },
        populate: {
          sender: {
            fields: ['id', 'username', 'email']
          },
          order: {
            fields: ['id', 'description'],
            populate: {
              advertiser: {
                fields: ['id', 'username', 'email']
              },
              publisher: {
                fields: ['id', 'username', 'email']
              }
            }
          }
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::communication.communication').count({ where: filters });

      ctx.send({
        data: communications,
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
      console.error('[ADMIN COMMUNICATIONS FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch communications');
    }
  },

  /**
   * Get single communication with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;

      const communication = await strapi.entityService.findOne('api::communication.communication', id, {
        populate: {
          sender: {
            select: ['id', 'username', 'email', 'firstName', 'lastName', 'phoneNumber']
          },
          order: {
            populate: {
              advertiser: {
                select: ['id', 'username', 'email', 'firstName', 'lastName']
              },
              publisher: {
                select: ['id', 'username', 'email', 'firstName', 'lastName']
              }
            }
          }
        }
      });

      if (!communication) {
        return ctx.notFound('Communication not found');
      }

      ctx.send({
        data: communication
      });

    } catch (error) {
      console.error('[ADMIN COMMUNICATION FIND ONE ERROR]', error);
      return ctx.internalServerError('Failed to fetch communication details');
    }
  },

  /**
   * Send admin message (admin action)
   */
  async sendMessage(ctx) {
    try {
      const { orderId, message, messageType = 'admin_message' } = ctx.request.body;

      if (!orderId || !message) {
        return ctx.badRequest('Order ID and message are required');
      }

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} sending message to order ${orderId}`);

      const communication = await strapi.entityService.create('api::communication.communication', {
        data: {
          sender: ctx.state.user.id,
          order: orderId,
          message,
          messageType,
          isAdminMessage: true,
          publishedAt: new Date()
        },
        populate: {
          sender: {
            select: ['id', 'username', 'email']
          },
          order: {
            select: ['id', 'description']
          }
        }
      });

      ctx.send({
        data: communication
      });

    } catch (error) {
      console.error('[ADMIN COMMUNICATION SEND MESSAGE ERROR]', error);
      return ctx.internalServerError('Failed to send admin message');
    }
  },

  /**
   * Flag communication for review (admin action)
   */
  async flag(ctx) {
    try {
      const { id } = ctx.params;
      const { reason, priority = 'medium' } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} flagging communication ${id}. Reason: ${reason}`);

      const updatedCommunication = await strapi.entityService.update('api::communication.communication', id, {
        data: {
          isFlagged: true,
          flagReason: reason,
          flagPriority: priority,
          flaggedAt: new Date(),
          flaggedBy: ctx.state.user.id
        },
        populate: ['sender', 'order']
      });

      ctx.send({
        data: updatedCommunication
      });

    } catch (error) {
      console.error('[ADMIN COMMUNICATION FLAG ERROR]', error);
      return ctx.internalServerError('Failed to flag communication');
    }
  },

  /**
   * Unflag communication (admin action)
   */
  async unflag(ctx) {
    try {
      const { id } = ctx.params;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} unflagging communication ${id}`);

      const updatedCommunication = await strapi.entityService.update('api::communication.communication', id, {
        data: {
          isFlagged: false,
          flagReason: null,
          flagPriority: null,
          unflaggedAt: new Date(),
          unflaggedBy: ctx.state.user.id
        },
        populate: ['sender', 'order']
      });

      ctx.send({
        data: updatedCommunication
      });

    } catch (error) {
      console.error('[ADMIN COMMUNICATION UNFLAG ERROR]', error);
      return ctx.internalServerError('Failed to unflag communication');
    }
  },

  /**
   * Delete communication (admin action)
   */
  async delete(ctx) {
    try {
      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} deleting communication ${id}. Reason: ${reason}`);

      // Archive instead of hard delete
      await strapi.entityService.update('api::communication.communication', id, {
        data: {
          isDeleted: true,
          deletionReason: reason,
          deletedAt: new Date(),
          deletedBy: ctx.state.user.id
        }
      });

      ctx.send({
        message: 'Communication deleted successfully'
      });

    } catch (error) {
      console.error('[ADMIN COMMUNICATION DELETE ERROR]', error);
      return ctx.internalServerError('Failed to delete communication');
    }
  },

  /**
   * Get communication statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      const total = await strapi.db.query('api::communication.communication').count();
      const flagged = await strapi.db.query('api::communication.communication').count({
        where: { isFlagged: true }
      });
      const adminMessages = await strapi.db.query('api::communication.communication').count({
        where: { isAdminMessage: true }
      });

      // Get new communications this month
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);

      const newThisMonth = await strapi.db.query('api::communication.communication').count({
        where: {
          createdAt: {
            $gte: thisMonth.toISOString()
          }
        }
      });

      // Get message type breakdown
      const messageTypes = await strapi.db.query('api::communication.communication').findMany({
        select: ['messageType']
      });
      
      const typeBreakdown = {};
      messageTypes.forEach(comm => {
        const type = comm.messageType || 'general';
        typeBreakdown[type] = (typeBreakdown[type] || 0) + 1;
      });

      ctx.send({
        total,
        flagged,
        adminMessages,
        newThisMonth,
        typeBreakdown
      });

    } catch (error) {
      console.error('[ADMIN COMMUNICATION STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch communication statistics');
    }
  },

  /**
   * Get flagged communications for review
   */
  async getFlagged(ctx) {
    try {
      const { page = 1, pageSize = 20 } = ctx.query;

      const flaggedComms = await strapi.entityService.findMany('api::communication.communication', {
        filters: { isFlagged: true },
        sort: 'flaggedAt:desc',
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize)
        },
        populate: {
          sender: {
            select: ['id', 'username', 'email']
          },
          order: {
            select: ['id', 'description']
          }
        }
      });

      const total = await strapi.db.query('api::communication.communication').count({
        where: { isFlagged: true }
      });

      ctx.send({
        data: flaggedComms,
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
      console.error('[ADMIN COMMUNICATION FLAGGED ERROR]', error);
      return ctx.internalServerError('Failed to fetch flagged communications');
    }
  }

}));
