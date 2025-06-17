'use strict';

module.exports = {
  async getUserCart(ctx) {
    const { user } = ctx.state;
    
    try {
      // Find the user's cart or create a new one
      let cart = await strapi.db.query('api::cart.cart').findOne({
        where: { user: user.id },
        populate: ['user']
      });

      if (!cart) {
        cart = await strapi.entityService.create('api::cart.cart', {
          data: {
            items: [],
            formData: {},
            sourceProjectId: null,
            user: user.id
          }
        });
      }

      return cart;
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async updateUserCart(ctx) {
    const { user } = ctx.state;
    const { items, formData, sourceProjectId } = ctx.request.body;
    
    try {
      // Find the user's cart
      let cart = await strapi.db.query('api::cart.cart').findOne({
        where: { user: user.id }
      });

      // If cart doesn't exist, create it
      if (!cart) {
        cart = await strapi.entityService.create('api::cart.cart', {
          data: {
            items,
            formData,
            sourceProjectId,
            user: user.id
          }
        });
      } else {
        // Update existing cart
        cart = await strapi.entityService.update('api::cart.cart', cart.id, {
          data: {
            items,
            formData,
            sourceProjectId
          }
        });
      }

      return cart;
    } catch (error) {
      ctx.throw(500, error);
    }
  }
}; 