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
        return ctx.forbidden('You are not authorized to add communications to this order');
      }
      
      // Create the communication with the current user as sender
      const entity = await strapi.entityService.create('api::communication.communication', {
        data: {
          message: data.message,
          sender: user.id,
          order: data.order,
          communicationStatus: data.communicationStatus || 'requested',
        },
      });
      
      // Get the created entity with populated relations
      const populatedEntity = await strapi.entityService.findOne('api::communication.communication', entity.id, {
        populate: ['sender', 'order'],
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