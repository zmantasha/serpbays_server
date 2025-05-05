'use strict';

module.exports = {
  // Handle webhook callbacks from payment gateways
  async handleWebhook(ctx) {
    const { gateway } = ctx.params;
    const payload = ctx.request.body;
    
    if (!['stripe', 'paypal', 'razorpay'].includes(gateway)) {
      return ctx.badRequest('Invalid payment gateway');
    }

    try {
      // Process the webhook through the payment service
      const paymentService = strapi.service('api::user-wallet.payment');
      const result = await paymentService.handleWebhook(gateway, payload);
      
      return result;
    } catch (error) {
      ctx.throw(500, error);
    }
  }
}; 