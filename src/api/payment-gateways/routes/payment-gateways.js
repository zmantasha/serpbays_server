'use strict';

/**
 * Payment Gateways Router
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/payment-gateways/enabled',
      handler: 'payment-gateways.getEnabled',
      config: {
        auth: false // Allow public access to check enabled gateways
      }
    },
    {
      method: 'POST',
      path: '/payment-gateways/calculate-fees',
      handler: 'payment-gateways.calculateFees',
      config: {
        auth: false // Allow public access for fee calculation
      }
    },
    {
      method: 'PUT',
      path: '/payment-gateways/settings',
      handler: 'payment-gateways.updateSettings',
      config: {
        auth: {
          strategies: ['jwt'],
          scope: ['admin']
        }
      }
    }
  ]
};
