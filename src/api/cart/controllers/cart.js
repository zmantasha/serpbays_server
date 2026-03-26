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
                serviceType: item.serviceType || null,
                specialCategory: item.specialCategory || null,
                website: {
                  id: marketplace.id,
                  domain: marketplace.url,
                  url: marketplace.url,
                  regularPrice: marketplace.price,
                  sensitivePrice: item.isSensitive ?
                    (item.serviceType === 'link_insertion' ?
                      (item.specialCategory === 'CBD' ? marketplace.adv_li_cbd_pricing :
                        item.specialCategory === 'Casino' ? marketplace.adv_li_casino_pricing :
                          item.specialCategory === 'Crypto' ? marketplace.adv_li_crypto_pricing :
                            item.specialCategory === 'Dating' ? marketplace.adv_li_dating_pricing :
                              marketplace.link_insertion_price) :
                      (item.specialCategory === 'CBD' ? marketplace.adv_cbd_pricing :
                        item.specialCategory === 'Casino' ? marketplace.adv_casino_pricing :
                          item.specialCategory === 'Crypto' ? marketplace.adv_crypto_pricing :
                            item.specialCategory === 'Dating' ? marketplace.adv_dating_pricing :
                              marketplace.price)) :
                    (item.serviceType === 'link_insertion' ? marketplace.link_insertion_price : marketplace.price),
                  link_insertion_price: marketplace.link_insertion_price || 0,
                  da: marketplace.moz_da,
                  dr: marketplace.ahrefs_dr,
                  minWordCount: marketplace.min_word_count,
                  guidelines: marketplace.guidelines,
                  backlinkValidity: marketplace.backlink_validity,
                  dofollow: marketplace.dofollow_link === 1,
                  dofollowLinks: marketplace.dofollow_link?.toString(),
                  description: marketplace.description || '',
                  category: marketplace.category,
                  traffic: marketplace.ahrefs_traffic,
                  publisher_writing_price: marketplace.publisher_writing_price,
                  backlinkType: marketplace.backlink_type
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

      // Check if user is VIP and apply per-field discount
      let vipDiscount = null;
      try {
        const currentUser = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { id: userId },
        });

        if (currentUser?.isVIP) {
          const vipSettings = await strapi.service('api::vip-settings.vip-settings').getSettings();

          // Per-field discount resolution: category > service type > global
          const getVipDiscountPct = (serviceType, specialCategory) => {
            const globalPct = parseFloat(vipSettings.discountPercentage) || 0;
            const gpPct = parseFloat(vipSettings.guestPostDiscount) || 0;
            const liPct = parseFloat(vipSettings.linkInsertionDiscount) || 0;
            const isLI = serviceType === 'link_insertion';

            // GP sensitive
            const gpCbdPct = parseFloat(vipSettings.gpCbdDiscount) || 0;
            const gpCasinoPct = parseFloat(vipSettings.gpCasinoDiscount) || 0;
            const gpCryptoPct = parseFloat(vipSettings.gpCryptoDiscount) || 0;
            const gpDatingPct = parseFloat(vipSettings.gpDatingDiscount) || 0;
            // LI sensitive
            const liCbdPct = parseFloat(vipSettings.liCbdDiscount) || 0;
            const liCasinoPct = parseFloat(vipSettings.liCasinoDiscount) || 0;
            const liCryptoPct = parseFloat(vipSettings.liCryptoDiscount) || 0;
            const liDatingPct = parseFloat(vipSettings.liDatingDiscount) || 0;

            if (specialCategory === 'CBD') { const p = isLI ? liCbdPct : gpCbdPct; return p > 0 ? p : globalPct; }
            if (specialCategory === 'Casino') { const p = isLI ? liCasinoPct : gpCasinoPct; return p > 0 ? p : globalPct; }
            if (specialCategory === 'Crypto') { const p = isLI ? liCryptoPct : gpCryptoPct; return p > 0 ? p : globalPct; }
            if (specialCategory === 'Dating') { const p = isLI ? liDatingPct : gpDatingPct; return p > 0 ? p : globalPct; }
            return (isLI ? liPct : gpPct) || globalPct;
          };

          let totalSavings = 0;
          let hasDiscount = false;

          for (const item of itemsWithLiveData) {
            if (item.website) {
              const discountPct = getVipDiscountPct(item.serviceType, item.specialCategory);
              if (discountPct > 0) {
                const originalPrice = parseFloat(item.website.sensitivePrice) || 0;
                const discountedPrice = Math.round(originalPrice * (1 - discountPct / 100) * 100) / 100;
                item.website.vipPrice = discountedPrice;
                item.website.vipDiscountPercentage = discountPct;
                totalSavings += (originalPrice - discountedPrice) * (item.quantity || 1);
                hasDiscount = true;
              }
            }
          }

          if (hasDiscount) {
            vipDiscount = {
              enabled: true,
              percentage: parseFloat(vipSettings.discountPercentage) || 0,
              totalSavings: Math.round(totalSavings * 100) / 100,
            };
          }
        }
      } catch (vipErr) {
        console.error('Error applying VIP discount to cart:', vipErr);
        // Non-blocking — cart still works without VIP pricing
      }

      return {
        ...cart,
        items: itemsWithLiveData,
        ...(vipDiscount && { vipDiscount }),
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