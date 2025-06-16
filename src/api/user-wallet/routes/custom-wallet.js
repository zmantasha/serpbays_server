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
      method: 'POST',
      path: '/api/wallet/create',
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
      path: '/api/wallet/redeem-promo',
      handler: 'user-wallet.redeemPromo',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.redeemPromo']
        },
        policies: [],
        middlewares: []
      }
    }
  ]
}; 