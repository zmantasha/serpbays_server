'use strict';

/**
 * user-wallet router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = {
    routes: [
        {
            method: 'GET',
            path: '/api/user-wallets',
      handler: 'user-wallet.find',
            config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.find']
        }
      }
        },
        {
            method: 'GET',
            path: '/api/user-wallets/:id',
      handler: 'user-wallet.findOne',
            config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.findOne']
        }
      }
        },
        {
            method: 'POST',
            path: '/api/user-wallets',
      handler: 'user-wallet.create',
            config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.create']
        }
      }
        },
        {
            method: 'PUT',
            path: '/api/user-wallets/:id',
      handler: 'user-wallet.update',
            config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.update']
        }
      }
        },
        {
            method: 'DELETE',
            path: '/api/user-wallets/:id',
      handler: 'user-wallet.delete',
            config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.delete']
        }
      }
    },
    {
      method: 'GET',
      path: '/api/wallet/balance',
      handler: 'user-wallet.getBalance',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.find']
        }
      }
    },
        {
            method: 'GET',
      path: '/api/wallet/transactions',
      handler: 'user-wallet.getTransactions',
            config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.find']
        }
      }
    },
    {
      method: 'POST',
      path: '/api/wallet/create',
      handler: 'user-wallet.createWallet',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.create']
        }
      }
    }
  ]
};
