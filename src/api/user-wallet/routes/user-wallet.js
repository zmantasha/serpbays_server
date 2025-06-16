'use strict';

/**
 * user-wallet router
 */

module.exports = {
  routes: [
    // Core CRUD routes
    {
      method: 'GET',
      path: '/api/user-wallets',
      handler: 'user-wallet.find',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.find']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/api/user-wallets/:id',
      handler: 'user-wallet.findOne',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.findOne']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/api/user-wallets',
      handler: 'user-wallet.create',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.create']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'PUT',
      path: '/api/user-wallets/:id',
      handler: 'user-wallet.update',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.update']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'DELETE',
      path: '/api/user-wallets/:id',
      handler: 'user-wallet.delete',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.delete']
        },
        policies: [],
        middlewares: []
      }
    }
  ]
};
