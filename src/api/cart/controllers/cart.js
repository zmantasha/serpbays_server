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
      
      if (!cart) {
        return { items: [], formData: {}, sourceProjectId: null };
      }
      
      // Fetch live marketplace data for cart items
      const itemsWithLiveData = [];
      if (cart.items && Array.isArray(cart.items)) {
        for (const item of cart.items) {
          try {
            // Get current marketplace data
            const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { id: item.marketplaceId || item.website?.id }
            });
            
            if (marketplace) {
              // Create updated item with live marketplace data
              const updatedItem = {
                id: item.id,
                quantity: item.quantity || 1,
                isSensitive: item.isSensitive || false,
                specialCategory: item.specialCategory || null,
                website: {
                  id: marketplace.id,
                  domain: marketplace.url,
                  url: marketplace.url,
                  regularPrice: marketplace.price,
                  sensitivePrice: item.isSensitive ? 
                    (item.specialCategory === 'CBD' ? marketplace.adv_cbd_pricing :
                     item.specialCategory === 'Casino' ? marketplace.adv_casino_pricing :
                     item.specialCategory === 'Crypto' ? marketplace.adv_crypto_pricing :
                     marketplace.price) : marketplace.price,
                  da: marketplace.moz_da,
                  dr: marketplace.ahrefs_dr,
                  minWordCount: marketplace.min_word_count,
                  guidelines: marketplace.guidelines,
                  backlinkValidity: marketplace.backlink_validity,
                  dofollow: marketplace.dofollow_link === 1,
                  dofollowLinks: marketplace.dofollow_link?.toString(),
                  description: marketplace.description || '',
                  category: marketplace.category,
                  traffic: marketplace.ahrefs_traffic
                }
              };
              itemsWithLiveData.push(updatedItem);
            } else {
              console.warn(`Marketplace item ${item.marketplaceId || item.website?.id} not found, removing from cart`);
              // Item no longer exists in marketplace, skip it (auto-cleanup)
            }
          } catch (err) {
            console.error('Error fetching marketplace data for cart item:', err);
            // Keep original item if there's an error
            itemsWithLiveData.push(item);
          }
        }
      }
      
      return {
        ...cart,
        items: itemsWithLiveData
      };
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