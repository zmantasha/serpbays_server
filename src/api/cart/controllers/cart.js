const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::cart.cart', ({ strapi }) => ({
  async getUserCart(ctx) {
    try {
      const userId = ctx.state.user.id;
      
      // Find user's cart
      const cart = await strapi.db.query('api::cart.cart').findOne({
        where: { user: userId },
        populate: ['user'],
      });
      
      return cart || { items: [], formData: {}, sourceProjectId: null };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async updateCart(ctx) {
    try {
      const userId = ctx.state.user.id;
      const { items, formData, sourceProjectId } = ctx.request.body;
      
      // Find existing cart
      let cart = await strapi.db.query('api::cart.cart').findOne({
        where: { user: userId },
      });
      
      if (cart) {
        // Update existing cart
        cart = await strapi.db.query('api::cart.cart').update({
          where: { id: cart.id },
          data: {
            items,
            formData,
            sourceProjectId,
          },
        });
      } else {
        // Create new cart
        cart = await strapi.db.query('api::cart.cart').create({
          data: {
            items,
            formData,
            sourceProjectId,
            user: userId,
          },
        });
      }
      
      return cart;
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async clearCart(ctx) {
    try {
      const userId = ctx.state.user.id;
      
      // Find user's cart
      const cart = await strapi.db.query('api::cart.cart').findOne({
        where: { user: userId },
      });
      
      if (cart) {
        // Update cart with empty data
        await strapi.db.query('api::cart.cart').update({
          where: { id: cart.id },
          data: {
            items: [],
            formData: {},
            sourceProjectId: null,
          },
        });
      }
      
      return { items: [], formData: {}, sourceProjectId: null };
    } catch (error) {
      ctx.throw(500, error);
    }
  },
})); 