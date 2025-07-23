module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/api/wallet/redeem-promo',
      handler: 'user-wallet.redeemPromo',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.create']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST', 
      path: '/api/api/wallet/redeem-promo',
      handler: 'user-wallet.redeemPromo',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.create']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/api/wallet/check-promo',
      handler: 'user-wallet.checkPromoCode',
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.create']
        },
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/api/api/wallet/check-promo',
      handler: 'user-wallet.checkPromoCode', 
      config: {
        auth: {
          scope: ['api::user-wallet.user-wallet.create']
        },
        policies: [],
        middlewares: []
      }
    }
  ]
} 