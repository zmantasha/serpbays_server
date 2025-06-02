'use strict';

/**
 * order-content controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::order-content.order-content', ({ strapi }) => ({
  // Create a new order content with current user as owner
  async create(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to create order content');
      }

      // Get request body data
      const { order: orderId, ...data } = ctx.request.body.data || ctx.request.body;
      
      // If order ID is provided, verify that the order belongs to the user
      if (orderId) {
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['advertiser'],
        });
        
        if (!order) {
          return ctx.notFound('Order not found');
        }
        
        if (order.advertiser.id !== ctx.state.user.id) {
          return ctx.forbidden('You can only create content for your own orders');
        }
      }
      
      // Create the order content
      const entity = await strapi.entityService.create('api::order-content.order-content', {
        data: {
          ...data,
          order: orderId,
        },
      });
      
      return entity;
    } catch (error) {
      return ctx.badRequest('Failed to create order content', { error: error.message });
    }
  },

  // Update order content only if it belongs to user's order
  async update(ctx) {
    try {
      const { id } = ctx.params;
      
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to update order content');
      }
      
      // Find existing content
      const existingContent = await strapi.entityService.findOne('api::order-content.order-content', id, {
        populate: ['order.advertiser'],
      });
      
      if (!existingContent) {
        return ctx.notFound('Order content not found');
      }
      
      // Check if user owns the associated order
      if (existingContent.order?.advertiser?.id !== ctx.state.user.id) {
        return ctx.forbidden('You can only update content for your own orders');
      }
      
      // Update the content
      const entity = await strapi.entityService.update('api::order-content.order-content', id, {
        data: ctx.request.body.data || ctx.request.body,
      });
      
      return entity;
    } catch (error) {
      return ctx.badRequest('Failed to update order content', { error: error.message });
    }
  },
})); 