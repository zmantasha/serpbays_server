'use strict';

/**
 * Admin Orders Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::order.order', ({ strapi }) => ({

  /**
   * Get all orders with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const { 
        page = 1, 
        pageSize = 20, 
        sort = 'createdAt:desc',
        search = '',
        status = '',
        advertiserId = '',
        publisherId = ''
      } = ctx.query;

      // Build filters
      const filters = {};
      
      // Search filter
      if (search) {
        filters.$or = [
          { description: { $containsi: search } },
          { website: { $containsi: search } },
          { id: { $eq: parseInt(search) || 0 } }
        ];
      }

      // Status filter
      if (status) {
        filters.orderStatus = status;
      }

      // Advertiser filter
      if (advertiserId) {
        filters.advertiser = advertiserId;
      }

      // Publisher filter
      if (publisherId) {
        filters.publisher = publisherId;
      }

      // Get orders with pagination using db.query
      const orders = await strapi.db.query('api::order.order').findMany({
        where: filters,
        orderBy: sort === 'createdAt:desc' ? { createdAt: 'desc' } : { createdAt: 'asc' },
        offset: (parseInt(page) - 1) * parseInt(pageSize),
        limit: parseInt(pageSize),
        populate: {
          advertiser: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          },
          publisher: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          }
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::order.order').count({ where: filters });

      ctx.send({
        data: orders,
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
      console.error('[ADMIN ORDERS FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch orders');
    }
  },

  /**
   * Get single order with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;

      const order = await strapi.entityService.findOne('api::order.order', id, {
        populate: {
          advertiser: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName', 'phoneNumber']
          },
          publisher: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName', 'phoneNumber']
          },
          orderContent: {
            fields: ['url', 'metaDescription', 'keywords', 'links', 'minWordCount']
          },
          outsourcedContent: {
            fields: ['links', 'instructions']
          },
          communications: {
            populate: ['sender'],
            sort: 'createdAt:desc'
          },
          transactions: {
            sort: 'createdAt:desc'
          }
        }
      });

      if (!order) {
        return ctx.notFound('Order not found');
      }

      ctx.send({
        data: order
      });

    } catch (error) {
      console.error('[ADMIN ORDER FIND ONE ERROR]', error);
      return ctx.internalServerError('Failed to fetch order details');
    }
  },

  /**
   * Update order status (admin action)
   */
  async updateStatus(ctx) {
    try {
      const { id } = ctx.params;
      const { orderStatus, adminNotes } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} updating order ${id} status to ${orderStatus}`);

      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: { 
          orderStatus,
          adminNotes,
          lastStatusUpdate: new Date()
        },
        populate: ['advertiser', 'publisher']
      });

      // Create communication log for status update
      if (orderStatus) {
        await strapi.entityService.create('api::communication.communication', {
          data: {
            sender: ctx.state.user.id,
            order: id,
            message: `Order status updated to ${orderStatus}${adminNotes ? `. Admin notes: ${adminNotes}` : ''}`,
            messageType: 'status_update',
            isAdminMessage: true,
            publishedAt: new Date()
          }
        });
      }

      ctx.send({
        data: updatedOrder
      });

    } catch (error) {
      console.error('[ADMIN ORDER UPDATE STATUS ERROR]', error);
      return ctx.internalServerError('Failed to update order status');
    }
  },

  /**
   * Assign publisher to order
   */
  async assignPublisher(ctx) {
    try {
      const { id } = ctx.params;
      const { publisherId } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} assigning publisher ${publisherId} to order ${id}`);

      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: { 
          publisher: publisherId,
          orderStatus: 'assigned',
          assignedAt: new Date()
        },
        populate: ['advertiser', 'publisher']
      });

      // Create communication log for assignment
      await strapi.entityService.create('api::communication.communication', {
        data: {
          sender: ctx.state.user.id,
          order: id,
          message: `Order assigned to publisher ${updatedOrder.publisher?.username || publisherId}`,
          messageType: 'assignment',
          isAdminMessage: true,
          publishedAt: new Date()
        }
      });

      ctx.send({
        data: updatedOrder
      });

    } catch (error) {
      console.error('[ADMIN ORDER ASSIGN PUBLISHER ERROR]', error);
      return ctx.internalServerError('Failed to assign publisher');
    }
  },

  /**
   * Get order statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      const total = await strapi.db.query('api::order.order').count();
      const pending = await strapi.db.query('api::order.order').count({
        where: { orderStatus: 'pending' }
      });
      const inProgress = await strapi.db.query('api::order.order').count({
        where: { orderStatus: 'in_progress' }
      });
      const completed = await strapi.db.query('api::order.order').count({
        where: { orderStatus: 'completed' }
      });
      const cancelled = await strapi.db.query('api::order.order').count({
        where: { orderStatus: 'cancelled' }
      });

      // Calculate total revenue
      const revenueData = await strapi.db.query('api::order.order').findMany({
        where: { orderStatus: 'completed' },
        select: ['totalAmount']
      });
      const totalRevenue = revenueData.reduce((sum, order) => {
        return sum + parseFloat(order.totalAmount || 0);
      }, 0);

      // Get new orders this month
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);

      const newThisMonth = await strapi.db.query('api::order.order').count({
        where: {
          createdAt: {
            $gte: thisMonth.toISOString()
          }
        }
      });

      ctx.send({
        total,
        pending,
        inProgress,
        completed,
        cancelled,
        totalRevenue: totalRevenue.toFixed(2),
        newThisMonth
      });

    } catch (error) {
      console.error('[ADMIN ORDER STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch order statistics');
    }
  },

  /**
   * Cancel order (admin action)
   */
  async cancelOrder(ctx) {
    try {
      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} cancelling order ${id}. Reason: ${reason}`);

      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: { 
          orderStatus: 'cancelled',
          cancellationReason: reason,
          cancelledAt: new Date(),
          cancelledBy: ctx.state.user.id
        },
        populate: ['advertiser', 'publisher']
      });

      // Create communication log for cancellation
      await strapi.entityService.create('api::communication.communication', {
        data: {
          sender: ctx.state.user.id,
          order: id,
          message: `Order cancelled by admin. Reason: ${reason || 'No reason provided'}`,
          messageType: 'cancellation',
          isAdminMessage: true,
          publishedAt: new Date()
        }
      });

      ctx.send({
        data: updatedOrder
      });

    } catch (error) {
      console.error('[ADMIN ORDER CANCEL ERROR]', error);
      return ctx.internalServerError('Failed to cancel order');
    }
  },

  /**
   * Get order content (admin access)
   */
  async getOrderContent(ctx) {
    try {
      const { id } = ctx.params;
      
      // Find the order content for this order
      const orderContent = await strapi.db.query('api::order-content.order-content').findOne({
        where: { order: id },
      });
      
      // Find the outsourced content for this order
      const outsourcedContent = await strapi.db.query('api::outsourced-content.outsourced-content').findOne({
        where: { order: id },
      });
      
      ctx.send({
        orderContent,
        outsourcedContent
      });
    } catch (error) {
      console.error('[ADMIN ORDER CONTENT ERROR]', error);
      return ctx.internalServerError('Failed to fetch order content');
    }
  },

  /**
   * Get order chatroom and communications (admin access)
   */
  async getOrderChatroom(ctx) {
    try {
      const { id } = ctx.params;
      console.log('[ADMIN ORDER CHATROOM] Fetching chatroom for order:', id);
      
      // Find the chatroom for this order
      const chatroom = await strapi.db.query('api::chatroom.chatroom').findOne({
        where: { order: id },
        populate: {
          order: {
            fields: ['id', 'description', 'orderStatus']
          },
          advertiser: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          },
          publisher: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          },
          communications: {
            populate: {
              sender: {
                fields: ['id', 'username', 'email', 'firstName', 'lastName']
              }
            },
            orderBy: { createdAt: 'asc' }
          }
        }
      });
      
      if (!chatroom) {
        console.log('[ADMIN ORDER CHATROOM] No existing chatroom found, creating new one');
        // Create a new chatroom if it doesn't exist
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['advertiser', 'publisher']
        });
        
        if (!order) {
          console.log('[ADMIN ORDER CHATROOM] Order not found:', id);
          return ctx.notFound('Order not found');
        }
        
        // Check if there are existing communications for this order
        const existingCommunications = await strapi.db.query('api::communication.communication').findMany({
          where: { order: id },
          populate: {
            sender: {
              fields: ['id', 'username', 'email', 'firstName', 'lastName']
            }
          },
          orderBy: { createdAt: 'asc' }
        });
        
        console.log('[ADMIN ORDER CHATROOM] Found existing communications:', existingCommunications.length);
        
        const newChatroom = await strapi.db.query('api::chatroom.chatroom').create({
          data: {
            order: id,
            advertiser: order.advertiser?.id,
            publisher: order.publisher?.id,
            status: 'active',
            lastActivity: new Date()
          }
        });
        
        // If there are existing communications, link them to the new chatroom
        if (existingCommunications.length > 0) {
          await strapi.db.query('api::chatroom.chatroom').update({
            where: { id: newChatroom.id },
            data: {
              communications: {
                connect: existingCommunications.map(comm => comm.id)
              }
            }
          });
        }
        
        ctx.send({
          chatroom: newChatroom,
          communications: existingCommunications
        });
      } else {
        // If chatroom exists but has no communications, check for direct communications
        let communications = chatroom.communications || [];
        
        if (communications.length === 0) {
          // Fallback: get communications directly from the order
          communications = await strapi.db.query('api::communication.communication').findMany({
            where: { order: id },
            populate: {
              sender: {
                fields: ['id', 'username', 'email', 'firstName', 'lastName']
              }
            },
            orderBy: { createdAt: 'asc' }
          });
        }
        
        ctx.send({
          chatroom,
          communications: communications
        });
      }
    } catch (error) {
      console.error('[ADMIN ORDER CHATROOM ERROR]', error);
      return ctx.internalServerError('Failed to fetch order chatroom');
    }
  },

  /**
   * Send message in order chatroom (admin access)
   */
  async sendMessage(ctx) {
    try {
      const { id } = ctx.params;
      const { message, messageType = 'admin_message' } = ctx.request.body;
      
      if (!message || message.trim() === '') {
        return ctx.badRequest('Message cannot be empty');
      }
      
      // Find or create chatroom for this order
      let chatroom = await strapi.db.query('api::chatroom.chatroom').findOne({
        where: { order: id }
      });
      
      if (!chatroom) {
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['advertiser', 'publisher']
        });
        
        if (!order) {
          return ctx.notFound('Order not found');
        }
        
        chatroom = await strapi.db.query('api::chatroom.chatroom').create({
          data: {
            order: id,
            advertiser: order.advertiser?.id,
            publisher: order.publisher?.id,
            status: 'active',
            lastActivity: new Date()
          }
        });
      }
      
      // Create the communication message
      const communication = await strapi.db.query('api::communication.communication').create({
        data: {
          sender: ctx.state.user.id,
          order: id,
          message: message.trim(),
          messageType,
          isAdminMessage: true,
          publishedAt: new Date()
        }
      });
      
      // Add communication to chatroom
      await strapi.db.query('api::chatroom.chatroom').update({
        where: { id: chatroom.id },
        data: {
          communications: {
            connect: [communication.id]
          },
          lastActivity: new Date()
        }
      });
      
      // Return the created message with sender info
      const messageWithSender = await strapi.db.query('api::communication.communication').findOne({
        where: { id: communication.id },
        populate: {
          sender: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          }
        }
      });
      
      ctx.send({
        message: messageWithSender
      });
    } catch (error) {
      console.error('[ADMIN SEND MESSAGE ERROR]', error);
      return ctx.internalServerError('Failed to send message');
    }
  }

}));
