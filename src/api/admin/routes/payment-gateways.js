'use strict';

/**
 * Admin Payment Gateway Management Routes
 */

module.exports = {
  routes: [
    // Get payment gateway settings (admin only)
    {
      method: 'GET',
      path: '/api/admin/payment-gateways',
      handler: 'payment-gateways.getPaymentGateways',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: []
      }
    },

    // Update payment gateway settings (admin only)
    {
      method: 'PUT',
      path: '/api/admin/payment-gateways',
      handler: 'payment-gateways.updatePaymentGateways',
      config: {
        policies: ['global::is-super-admin'],
        middlewares: []
      }
    },

    // Get enabled payment gateways (public endpoint for client)
    {
      method: 'GET',
      path: '/api/payment-gateways/enabled',
      handler: 'payment-gateways.getEnabledPaymentGateways',
      config: {
        auth: false,
        middlewares: []
      }
    }
  ]
};



