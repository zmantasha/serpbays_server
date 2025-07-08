'use strict';

/**
 * communication controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::communication.communication', ({ strapi }) => ({
  
  // Create a new communication
  async create(ctx) {
    const { data } = ctx.request.body;
    
    try {
      // Get current user
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to create a communication');
      }
      
      // Validate required fields
      if (!data.message || !data.order) {
        return ctx.badRequest('Message and order ID are required');
      }
      
      // Check if the order exists
      const order = await strapi.entityService.findOne('api::order.order', data.order, {
        populate: ['advertiser', 'publisher', 'chatroom'],
      });
      
      if (!order) {
        return ctx.notFound('Order not found');
      }
      
      // Check if user is associated with the order
      if (
        order.advertiser?.id !== user.id && 
        order.publisher?.id !== user.id
      ) {
        return ctx.forbidden('You are not authorized to add communications to this order');
      }
      
      // Get or create chatroom for this order
      let chatroom = order.chatroom;
      if (!chatroom) {
        chatroom = await strapi.entityService.create('api::chatroom.chatroom', {
          data: {
            order: data.order,
            advertiser: order.advertiser?.id,
            publisher: order.publisher?.id,
            status: 'active',
            lastActivity: new Date(),
          },
        });
      } else {
        // Update last activity
        await strapi.entityService.update('api::chatroom.chatroom', chatroom.id, {
          data: { lastActivity: new Date() },
        });
      }
      
      // Create the communication with the current user as sender
      const entity = await strapi.entityService.create('api::communication.communication', {
        data: {
          message: data.message,
          sender: user.id,
          order: data.order,
          chatroom: chatroom.id,
          communicationStatus: data.communicationStatus || 'requested',
        },
      });
      
      // Get the created entity with populated relations
      const populatedEntity = await strapi.entityService.findOne('api::communication.communication', entity.id, {
        populate: ['sender', 'order', 'chatroom'],
      });
      
      // Determine recipient for the notification
      // If sender is advertiser, recipient is publisher, and vice-versa
      let recipientId;
      if (order.advertiser && order.publisher) {
        if (user.id === order.advertiser.id) {
          recipientId = order.publisher.id;
        } else if (user.id === order.publisher.id) {
          recipientId = order.advertiser.id;
        }
      }

      // Create notification for the recipient
      if (recipientId) {
        try {
          await strapi.service('api::notification.notification').createCommunicationNotification(
            recipientId,
            user.id, // senderId is the current user
            order.id,
            'message_received',
            { communicationId: entity.id }
          );
          console.log(`Notification created for message ${entity.id} to recipient ${recipientId}`);
        } catch (notificationError) {
          console.error('Failed to create message_received notification:', notificationError);
          // Don't fail the communication creation if notification fails
        }
      } else {
        console.warn(`Could not determine recipient for message_received notification for order ${order.id}. Advertiser: ${order.advertiser?.id}, Publisher: ${order.publisher?.id}, Sender: ${user.id}`);
      }

      return { data: populatedEntity };
    } catch (error) {
      console.error('Error creating communication:', error);
      return ctx.internalServerError('An error occurred while creating the communication');
    }
  },
  
  // Get communications for a specific order
  async getOrderCommunications(ctx) {
    const { orderId } = ctx.params;
    
    try {
      // Get current user
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to view communications');
      }
      
      // Check if the order exists and user is associated with it
      const order = await strapi.entityService.findOne('api::order.order', orderId, {
        populate: ['advertiser', 'publisher'],
      });
      
      if (!order) {
        return ctx.notFound('Order not found');
      }
      
      // Check if user is associated with the order
      if (
        order.advertiser?.id !== user.id && 
        order.publisher?.id !== user.id
      ) {
        return ctx.forbidden('You are not authorized to view communications for this order');
      }
      
      // Find all communications for this order
      const communications = await strapi.entityService.findMany('api::communication.communication', {
        filters: { order: orderId },
        sort: { createdAt: 'asc' },
        populate: ['sender'],
      });
      
      return { data: communications };
    } catch (error) {
      console.error('Error fetching order communications:', error);
      return ctx.internalServerError('An error occurred while fetching communications');
    }
  },
  
  // Update communication status
  async updateStatus(ctx) {
    const { id } = ctx.params;
    const { communicationStatus } = ctx.request.body;
    
    try {
      // Get current user
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to update a communication');
      }
      
      // Check if the communication exists
      const communication = await strapi.entityService.findOne('api::communication.communication', id, {
        populate: ['sender', 'order', 'order.advertiser', 'order.publisher'],
      });
      
      if (!communication) {
        return ctx.notFound('Communication not found');
      }
      
      // Check if user is associated with the order
      if (
        communication.order?.advertiser?.id !== user.id && 
        communication.order?.publisher?.id !== user.id
      ) {
        return ctx.forbidden('You are not authorized to update this communication');
      }
      
      // Validate status
      if (!['requested', 'acceptance', 'in_progress'].includes(communicationStatus)) {
        return ctx.badRequest('Invalid status value');
      }
      
      // Update the communication status
      const updated = await strapi.entityService.update('api::communication.communication', id, {
        data: { communicationStatus },
      });
      
      // Get the updated entity with populated relations
      const populatedEntity = await strapi.entityService.findOne('api::communication.communication', updated.id, {
        populate: ['sender', 'order'],
      });
      
      return { data: populatedEntity };
    } catch (error) {
      console.error('Error updating communication status:', error);
      return ctx.internalServerError('An error occurred while updating the communication status');
    }
  },
  
  // Get all conversations for current user
  async getUserConversations(ctx) {
    try {
      // Get current user
      const user = ctx.state.user;
      if (!user) {
        return ctx.unauthorized('You must be logged in to view conversations');
      }
      
      // Find all orders where user is either advertiser or publisher
      const orders = await strapi.entityService.findMany('api::order.order', {
        filters: {
          $or: [
            { advertiser: user.id },
            { publisher: user.id }
          ]
        },
        populate: ['advertiser', 'publisher', 'communications', 'communications.sender'],
        sort: { updatedAt: 'desc' }
      });
      
      // Group communications by order and get latest message for each conversation
      const conversations = [];
      
      for (const order of orders) {
        if (order.communications && order.communications.length > 0) {
          // Sort communications by creation date (latest first)
          const sortedComms = order.communications.sort((a, b) => 
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
          
          const latestMessage = sortedComms[0];
          const otherParty = order.advertiser?.id === user.id ? order.publisher : order.advertiser;
          
          // Count unread messages (messages from other party that are newer than user's last message)
          const userMessages = sortedComms.filter(comm => comm.sender?.id === user.id);
          const otherMessages = sortedComms.filter(comm => comm.sender?.id !== user.id);
          
          const lastUserMessageTime = userMessages.length > 0 ? 
            new Date(userMessages[0].createdAt).getTime() : 0;
          
          const unreadCount = otherMessages.filter(comm => 
            new Date(comm.createdAt).getTime() > lastUserMessageTime
          ).length;
          
          conversations.push({
            orderId: order.id,
            orderTitle: `Order #${order.websiteUrl}`,
            otherParty: {
              id: otherParty?.id,
              username: otherParty?.username,
              email: otherParty?.email
            },
            latestMessage: {
              id: latestMessage.id,
              message: latestMessage.message,
              sender: latestMessage.sender,
              createdAt: latestMessage.createdAt,
              communicationStatus: latestMessage.communicationStatus
            },
            unreadCount,
            totalMessages: order.communications.length,
            orderStatus: order.orderStatus,
            updatedAt: order.updatedAt
          });
        }
      }
      
      // Sort conversations by latest activity
      conversations.sort((a, b) => 
        new Date(b.latestMessage.createdAt).getTime() - new Date(a.latestMessage.createdAt).getTime()
      );
      
      return { 
        data: conversations,
        meta: {
          totalConversations: conversations.length,
          totalUnreadMessages: conversations.reduce((sum, conv) => sum + conv.unreadCount, 0)
        }
      };
    } catch (error) {
      console.error('Error fetching user conversations:', error);
      return ctx.internalServerError('An error occurred while fetching conversations');
    }
  },
  
  // New function to handle revision requests
  async requestRevision(ctx) {
    const { orderId } = ctx.params;
    const { message } = ctx.request.body;
    
    // Validate 5-day window for requesting revisions
    const order = await strapi.entityService.findOne('api::order.order', orderId);
    const deliveredDate = new Date(order.deliveredDate);
    const currentDate = new Date();
    const daysDifference = calculateWorkingDays(deliveredDate, currentDate);
    
    if (daysDifference > 5) {
      return ctx.badRequest('Revision can only be requested within 5 working days of delivery');
    }
    
    // Update order status and set revision timestamps
    await strapi.entityService.update('api::order.order', orderId, {
      data: {
        revisionRequestedAt: new Date(),
        revisionDeadline: calculateDeadline(new Date(), 5), // Add helper to calculate 5 working days
        revisionStatus: 'requested',
      }
    });
    
    // Create a communication record for the revision request
    await strapi.entityService.create('api::communication.communication', {
      data: {
        message: `Revision requested: ${message}`,
        sender: ctx.state.user.id,
        order: orderId,
        communicationStatus: 'requested',
      }
    });
    
    // Return updated order
    return { success: true };
  },
  
  // Add function to mark revision as in progress (for publisher)
  async startRevision(ctx) {
    const { orderId } = ctx.params;
    
    await strapi.entityService.update('api::order.order', orderId, {
      data: { revisionStatus: 'in_progress' }
    });
    
    // Create a communication record
    await strapi.entityService.create('api::communication.communication', {
      data: {
        message: 'Working on revision',
        sender: ctx.state.user.id,
        order: orderId,
        communicationStatus: 'in_progress',
      }
    });
    
    return { success: true };
  },
  
  // Add function to mark revision as completed (for publisher)
  async completeRevision(ctx) {
    const { orderId } = ctx.params;
    const { message } = ctx.request.body;
    
    await strapi.entityService.update('api::order.order', orderId, {
      data: { revisionStatus: 'completed' }
    });
    
    // Create a communication record
    await strapi.entityService.create('api::communication.communication', {
      data: {
        message: `Revision completed: ${message}`,
        sender: ctx.state.user.id,
        order: orderId,
        communicationStatus: 'acceptance',
      }
    });
    
    return { success: true };
  },
  
  // Add function to accept order (for advertiser)
  async acceptOrder(ctx) {
    const { orderId } = ctx.params;
    
    await strapi.entityService.update('api::order.order', orderId, {
      data: { 
        orderStatus: 'completed',
        orderAccepted: true,
        completedDate: new Date()
      }
    });
    
    // Create a final communication record
    await strapi.entityService.create('api::communication.communication', {
      data: {
        message: 'Order accepted and completed',
        sender: ctx.state.user.id,
        order: orderId,
        communicationStatus: 'acceptance',
      }
    });
    
    return { success: true };
  }
})); 