'use strict';

/**
 * order controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::order.order', ({ strapi }) => ({
  // Custom create method to handle order creation with content
  async create(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to create an order');
      }
      
      // Get authenticated user
      const user = ctx.state.user;
      
      // Extract order data and content data from request body
      const { content, ...orderData } = ctx.request.body.data || ctx.request.body;
      
      // Validate required fields
      if (!orderData.totalAmount || !orderData.description || !orderData.website) {
        return ctx.badRequest('Missing required fields: totalAmount, description and website are required');
      }
      
      // If website is passed as a string ID, convert it to the proper format
      if (typeof orderData.website === 'string' && !isNaN(parseInt(orderData.website))) {
        orderData.website = parseInt(orderData.website);
      } 
      // If it's a domain name, try to find the corresponding marketplace entry
      else if (typeof orderData.website === 'string') {
        const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
          where: { url: orderData.website }
        });
        
        if (!marketplace) {
          return ctx.badRequest(`Website with domain ${orderData.website} not found in marketplace`);
        }
        
        orderData.website = marketplace.id;
      }
      
      // Use the service to create the order (handles escrow and wallet operations)
      const order = await strapi.service('api::order.order').create(orderData, user);
      
      // If content data was provided, create order content
      if (content && order) {
        await strapi.entityService.create('api::order-content.order-content', {
          data: {
            ...content,
            order: order.id,
          },
        });
      }
      
      // Return the created order with populated relations
      const populatedOrder = await strapi.entityService.findOne('api::order.order', order.id, {
        populate: ['advertiser', 'publisher', 'website', 'orderContent'],
      });
      
      return {
        data: populatedOrder,
        meta: {
          message: 'Order created successfully with escrow hold'
        }
      };
    } catch (error) {
      // Handle common errors with appropriate responses
      if (error.message === 'Insufficient funds') {
        return ctx.badRequest('Insufficient funds in your wallet');
      }
      if (error.message === 'Advertiser wallet not found') {
        return ctx.badRequest('No advertiser wallet found for your account');
      }
      if (error.message === 'Authentication required') {
        return ctx.unauthorized('Authentication required');
      }
      
      // Log and return unexpected errors
      console.error('Order creation error:', error);
      return ctx.badRequest('Failed to create order', { error: error.message });
    }
  },

  // Get orders for the current user (both advertiser and publisher)
  async getMyOrders(ctx) {
    try {
      const user = ctx.state.user;
      
      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Query orders based on user's role (either as advertiser or publisher)
      const orders = await strapi.db.query('api::order.order').findMany({
        where: {
          $or: [
            { advertiser: user.id },
            { publisher: user.id }
          ]
        },
        populate: ['website', 'advertiser', 'publisher'],
        orderBy: { orderDate: 'desc' }
      });

      return {
        data: orders,
        meta: {
          count: orders.length
        }
      };
    } catch (error) {
      console.error('Error fetching user orders:', error);
      return ctx.internalServerError('An error occurred while fetching orders');
    }
  },

  // Get orders available for publishers to accept
  async getAvailableOrders(ctx) {
    try {
      const user = ctx.state.user;
      
      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Get publisher's websites
      const publisherWebsites = await strapi.db.query('api::marketplace.marketplace').findMany({
        where: { user: user.id }
      });

      if (!publisherWebsites || publisherWebsites.length === 0) {
        return {
          data: [],
          meta: {
            message: 'No websites found for this publisher'
          }
        };
      }

      // Get website IDs
      const websiteIds = publisherWebsites.map(website => website.id);

      // Find pending orders for these websites
      const orders = await strapi.db.query('api::order.order').findMany({
        where: {
          website: { $in: websiteIds },
          status: 'pending',
          publisher: null // No publisher assigned yet
        },
        populate: ['website', 'advertiser'],
        orderBy: { orderDate: 'desc' }
      });

      return {
        data: orders,
        meta: {
          count: orders.length
        }
      };
    } catch (error) {
      console.error('Error fetching available orders:', error);
      return ctx.internalServerError('An error occurred while fetching available orders');
    }
  },

  // Accept an order (for publishers)
  async acceptOrder(ctx) {
    try {
      const user = ctx.state.user;
      
      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      const { id } = ctx.params;
      
      // Get the order
      const order = await strapi.db.query('api::order.order').findOne({
        where: { id },
        populate: ['website']
      });

      if (!order) {
        return ctx.notFound('Order not found');
      }

      // Check if order is already accepted
      if (order.status !== 'pending' || order.publisher) {
        return ctx.badRequest('Order is already accepted or not available');
      }

      // Verify the publisher owns this website
      const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
        where: { id: order.website.id, user: user.id }
      });

      if (!isWebsiteOwner) {
        return ctx.forbidden('You do not have permission to accept this order');
      }

      // Update the order
      const updatedOrder = await strapi.db.query('api::order.order').update({
        where: { id },
        data: {
          publisher: user.id,
          status: 'accepted',
          acceptedDate: new Date()
        }
      });

      return {
        data: updatedOrder,
        meta: {
          message: 'Order accepted successfully'
        }
      };
    } catch (error) {
      console.error('Error accepting order:', error);
      return ctx.internalServerError('An error occurred while accepting the order');
    }
  },

  // Mark order as delivered (for publishers)
  async deliverOrder(ctx) {
    try {
      const user = ctx.state.user;
      
      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      const { id } = ctx.params;
      const { body } = ctx.request;
      
      // Get the order
      const order = await strapi.db.query('api::order.order').findOne({
        where: { id }
      });

      if (!order) {
        return ctx.notFound('Order not found');
      }

      // Check if user is the publisher for this order
      if (order.publisher !== user.id) {
        return ctx.forbidden('You do not have permission to update this order');
      }

      // Check if order is in 'accepted' status
      if (order.status !== 'accepted') {
        return ctx.badRequest('Order must be in "accepted" status to be marked as delivered');
      }

      // Update the order
      const updatedOrder = await strapi.db.query('api::order.order').update({
        where: { id },
        data: {
          status: 'delivered',
          deliveredDate: new Date(),
          deliveryProof: body.proof || ''
        }
      });

      return {
        data: updatedOrder,
        meta: {
          message: 'Order marked as delivered'
        }
      };
    } catch (error) {
      console.error('Error delivering order:', error);
      return ctx.internalServerError('An error occurred while updating the order');
    }
  },

  // Complete order and release escrow (for advertisers)
  async completeOrder(ctx) {
    try {
      const user = ctx.state.user;
      
      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      const { id } = ctx.params;
      
      // Get the order with related data
      const order = await strapi.db.query('api::order.order').findOne({
        where: { id },
        populate: ['publisher']
      });

      if (!order) {
        return ctx.notFound('Order not found');
      }

      // Check if user is the advertiser for this order
      if (order.advertiser !== user.id) {
        return ctx.forbidden('You do not have permission to complete this order');
      }

      // Check if order is in 'delivered' status
      if (order.status !== 'delivered') {
        return ctx.badRequest('Order must be in "delivered" status to be completed');
      }

      try {
        // Complete the order and release escrow using the order service
        const completedOrder = await strapi.service('api::order.order').completeOrder(order.id, user);

        return {
          data: completedOrder,
          meta: {
            message: 'Order completed successfully and payment released'
          }
        };
      } catch (serviceError) {
        console.error('Service error completing order:', serviceError);
        return ctx.badRequest(serviceError.message || 'Error processing order completion');
      }
    } catch (error) {
      console.error('Error completing order:', error);
      return ctx.internalServerError('An error occurred while completing the order');
    }
  },

  // Dispute an order (for advertisers)
  async disputeOrder(ctx) {
    try {
      const user = ctx.state.user;
      
      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      const { id } = ctx.params;
      const { body } = ctx.request;
      
      if (!body.reason) {
        return ctx.badRequest('Dispute reason is required');
      }

      // Get the order
      const order = await strapi.db.query('api::order.order').findOne({
        where: { id }
      });

      if (!order) {
        return ctx.notFound('Order not found');
      }

      // Check if user is the advertiser for this order
      if (order.advertiser !== user.id) {
        return ctx.forbidden('You do not have permission to dispute this order');
      }

      // Check if order is in 'delivered' status
      if (order.status !== 'delivered') {
        return ctx.badRequest('Only delivered orders can be disputed');
      }

      // Update the order
      const updatedOrder = await strapi.db.query('api::order.order').update({
        where: { id },
        data: {
          status: 'disputed',
          disputeReason: body.reason,
          disputeDate: new Date()
        }
      });

      // Here you might also want to notify admins about the dispute

      return {
        data: updatedOrder,
        meta: {
          message: 'Order has been marked as disputed'
        }
      };
    } catch (error) {
      console.error('Error disputing order:', error);
      return ctx.internalServerError('An error occurred while disputing the order');
    }
  }
}));
