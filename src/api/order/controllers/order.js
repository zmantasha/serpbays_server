'use strict';

/**
 * order controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::order.order', ({ strapi }) => ({
  // Override the default create controller action
  async create(ctx) {
    try {
      const { body } = ctx.request;
      
      // Validate required fields
      if (!body.totalAmount || !body.description || !body.website) {
        return ctx.badRequest('Missing required fields: totalAmount, description and website are required');
      }
      
      // Create the order
      const response = await strapi.service('api::order.order').create(body);
      
      return {
        data: response,
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
      return ctx.internalServerError('An error occurred while creating the order');
    }
  }
}));
