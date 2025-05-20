'use strict';

/**
 * `is-owner` middleware
 */

module.exports = (config, { strapi }) => {
  // Add your own logic here.
  return async (ctx, next) => {
    const user = ctx.state.user;
    
    if (!user) {
      return ctx.unauthorized('You must be logged in');
    }
    
    // Check if user is an admin
    if (user.role && user.role.name === 'Administrator') {
      return await next();
    }
    
    // Get the ID from the request
    const { id } = ctx.params;
    
    if (id) {
      // Get the order associated with this outsourced content
      const outsourcedContent = await strapi.db.query('api::outsourced-content.outsourced-content').findOne({
        where: { id },
        populate: ['order']
      });
      
      if (!outsourcedContent) {
        return ctx.notFound('Outsourced content not found');
      }
      
      // Get the order details
      const order = await strapi.db.query('api::order.order').findOne({
        where: { id: outsourcedContent.order.id },
        populate: ['advertiser', 'publisher']
      });
      
      // Check if the user is either the advertiser or publisher for this order
      if (order && (order.advertiser?.id === user.id || order.publisher?.id === user.id)) {
        return await next();
      }
      
      return ctx.forbidden('You are not authorized to access this resource');
    }
    
    // For list queries, filter by user's orders
    if (ctx.method === 'GET' && !id) {
      // Modify the query to only include contents for orders associated with the user
      const userOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          $or: [
            { advertiser: user.id },
            { publisher: user.id }
          ]
        },
        select: ['id']
      });
      
      const orderIds = userOrders.map(order => order.id);
      
      // Add filter to the query
      ctx.query.filters = {
        ...(ctx.query.filters || {}),
        order: {
          id: {
            $in: orderIds
          }
        }
      };
    }
    
    await next();
  };
}; 