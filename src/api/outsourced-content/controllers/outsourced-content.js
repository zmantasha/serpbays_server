'use strict';

/**
 * outsourced-content controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::outsourced-content.outsourced-content', ({ strapi }) => ({
  // Custom create method
  async create(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to create outsourced content');
      }
      
      // Get data from request
      const { order, projectName, links } = ctx.request.body.data || ctx.request.body;
      
      if (!order || !projectName) {
        return ctx.badRequest('Missing required fields: order and projectName are required');
      }
      
      // Create the outsourced content entry
      const outsourcedContent = await strapi.entityService.create('api::outsourced-content.outsourced-content', {
        data: {
          projectName,
          links: typeof links === 'string' ? links : JSON.stringify(links),
          order,
          publishedAt: new Date()
        }
      });
      
      return { data: outsourcedContent };
    } catch (error) {
      console.error('Error creating outsourced content:', error);
      ctx.throw(500, error);
    }
  },
  
  // Fetch related outsourced content for an order
  async findByOrder(ctx) {
    try {
      const { id } = ctx.params;
      
      if (!id) {
        return ctx.badRequest('Order ID is required');
      }
      
      const outsourcedContent = await strapi.db.query('api::outsourced-content.outsourced-content').findOne({
        where: { order: id },
        populate: ['order']
      });
      
      if (!outsourcedContent) {
        return { data: null };
      }
      
      return { data: outsourcedContent };
    } catch (error) {
      console.error('Error finding outsourced content by order:', error);
      ctx.throw(500, error);
    }
  }
})); 