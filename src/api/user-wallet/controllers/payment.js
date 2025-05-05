'use strict';

/**
 * Payment controller
 */

module.exports = {
  // Handle Stripe webhook
  async webhookStripe(ctx) {
    try {
      return await strapi.service('api::user-wallet.payment').webhookStripe(ctx);
    } catch (error) {
      ctx.badRequest(`Stripe webhook error: ${error.message}`);
    }
  },

  // Handle PayPal webhook
  async webhookPaypal(ctx) {
    try {
      return await strapi.service('api::user-wallet.payment').webhookPaypal(ctx);
    } catch (error) {
      ctx.badRequest(`PayPal webhook error: ${error.message}`);
    }
  },

  // Handle Razorpay webhook
  async webhookRazorpay(ctx) {
    try {
      return await strapi.service('api::user-wallet.payment').webhookRazorpay(ctx);
    } catch (error) {
      ctx.badRequest(`Razorpay webhook error: ${error.message}`);
    }
  },

  // Handle test webhook
  async webhookTest(ctx) {
    try {
      return await strapi.service('api::user-wallet.payment').webhookTest(ctx);
    } catch (error) {
      ctx.badRequest(`Test webhook error: ${error.message}`);
    }
  }
}; 