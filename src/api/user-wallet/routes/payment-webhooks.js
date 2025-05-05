'use strict';

/**
 * Payment webhook routes
 */

module.exports = {
  routes: [
    // Webhook routes for different payment gateways
    {
      method: 'POST',
      path: '/api/payments/webhook/stripe',
      handler: 'api::user-wallet.payment.webhookStripe',
      config: {
        policies: [],
        // Disable CSRF for webhooks
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/api/payments/webhook/paypal',
      handler: 'api::user-wallet.payment.webhookPaypal',
      config: {
        policies: [],
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/api/payments/webhook/razorpay',
      handler: 'api::user-wallet.payment.webhookRazorpay',
      config: {
        policies: [],
        auth: false,
      },
    },
    // Generic webhook for testing
    {
      method: 'POST',
      path: '/api/payments/webhook/test',
      handler: 'api::user-wallet.payment.webhookTest',
      config: {
        policies: [],
        auth: false,
      },
    },
  ],
}; 