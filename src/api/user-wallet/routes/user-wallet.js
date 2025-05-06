'use strict';

/**
 * user-wallet router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = {
  routes: [
    // Standard CRUD routes
    ...createCoreRouter('api::user-wallet.user-wallet').routes,
    // Custom wallet endpoints
    {
      method: 'GET',
      path: '/api/wallet',
      handler: 'user-wallet.getWallet',
      config: {
        policies: [],
        auth: true
      }
    },
    {
      method: 'POST',
      path: '/api/wallet/transaction',
      handler: 'user-wallet.createTransaction',
      config: {
        policies: [],
        auth: true
      }
    },
    {
      method: 'GET',
      path: '/api/wallet/transactions',
      handler: 'user-wallet.getTransactions',
      config: {
        policies: [],
        auth: true
      }
    }
  ]
};
