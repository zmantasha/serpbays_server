'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/wallet',
      handler: 'wallet.getWallet',
      config: {
        auth: process.env.NODE_ENV === 'production',
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/wallet-transactions',
      handler: 'wallet.createTransaction',
      config: {
        auth: process.env.NODE_ENV === 'production',
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/wallet-transactions',
      handler: 'wallet.listTransactions',
      config: {
        auth: process.env.NODE_ENV === 'production',
        policies: [],
        middlewares: [],
      },
    },
  ],
}; 