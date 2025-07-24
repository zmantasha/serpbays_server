'use strict';

/**
 * user-wallet router
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/api/wallet/balance',
      handler: 'user-wallet.getBalance',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.getBalance']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/api/api/wallet/balance',
      handler: 'user-wallet.getBalance',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.getBalance']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/api/wallet/available-balance',
      handler: 'user-wallet.getAvailableBalance',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.getAvailableBalance']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/api/api/wallet/available-balance',
      handler: 'user-wallet.getAvailableBalance',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.getAvailableBalance']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/api/wallet/transactions',
      handler: 'user-wallet.getTransactions',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.getTransactions']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/api/api/wallet/transactions',
      handler: 'user-wallet.getTransactions',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.getTransactions']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/wallet/create',
      handler: 'user-wallet.createWallet',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.createWallet']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/wallet/check-promo',
      handler: 'user-wallet.checkPromoCode',
      config: {
        auth: {},
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/api/wallet/check-promo',
      handler: 'user-wallet.checkPromoCode',
      config: {
        auth: {},
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/wallet/test-post',
      handler: async (ctx) => {
        ctx.body = { message: 'POST route works' };
      },
      config: {
        auth: false,
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/wallet/redeem-promo',
      handler: 'user-wallet.redeemPromo',
      config: {
        auth: {},
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/api/wallet/redeem-promo',
      handler: 'user-wallet.redeemPromo',
      config: {
        auth: {},
        policies: [],
        middlewares: []
      }
    }
  ]
};
