'use strict';

/**
 * user-wallet router
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/api/wallet/add-funds',
      handler: 'user-wallet.addFunds',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.addFunds']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/api/api/wallet/add-funds',
      handler: 'user-wallet.addFunds',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.addFunds']
        },
        policies: [],
        middlewares: []
      }
    },
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
    },
    // Audit C5 — Route `POST /api/wallet/fix-earnings` removed.
    // The previous handler (`fixCompletedOrderEarnings`) iterated ALL completed
    // orders system-wide and double-credited publisher wallets on every call
    // (claimed-idempotent comment notwithstanding). The route was open to any
    // authenticated user (`auth: {}`), so any user could fire it repeatedly to
    // inflate any publisher's wallet by N× the sum of all approved orders.
    // The handler is also gone; the up_permissions rows are purged by
    // `database/migrations/2026.06.17T00.00.00.security-remove-fix-earnings-route.js`.
    // There is no replacement: live wallet credits flow through
    // `releaseEscrowToPublisher()` invoked by the order-completion path.
  ]
};
