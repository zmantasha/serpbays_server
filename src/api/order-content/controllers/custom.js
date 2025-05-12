'use strict';

/**
 * Custom order-content controller
 */

module.exports = {
  // Get content for a specific order
  async getOrderContent(ctx) {
    try {
      const { orderId } = ctx.params;
      
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to view order content');
      }
      
      // Find the order to check permissions
      const order = await strapi.entityService.findOne('api::order.order', orderId, {
        populate: ['advertiser', 'publisher'],
      });
      
      if (!order) {
        return ctx.notFound('Order not found');
      }
      
      // Check if user is either the advertiser or publisher for this order
      const userId = ctx.state.user.id;
      if (order.advertiser?.id !== userId && order.publisher?.id !== userId) {
        return ctx.forbidden('You can only view content for orders you are involved in');
      }
      
      // Find the content for this order
      const content = await strapi.db.query('api::order-content.order-content').findOne({
        where: { order: orderId },
      });
      
      if (!content) {
        return ctx.notFound('No content found for this order');
      }
      
      return content;
    } catch (error) {
      return ctx.badRequest('Failed to get order content', { error: error.message });
    }
  }
}; 