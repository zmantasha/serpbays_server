'use strict';

/**
 * Admin Wallet Management Routes
 */

module.exports = {
  routes: [
    // Get all users wallet information
    {
      method: 'GET',
      path: '/admin/wallets',
      handler: 'wallets.getAllWallets',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Get wallet statistics
    {
      method: 'GET',
      path: '/admin/wallets/stats',
      handler: 'wallets.getWalletStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Get specific user wallet details
    {
      method: 'GET',
      path: '/admin/wallets/:userId',
      handler: 'wallets.getUserWallet',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Get user wallet transactions
    {
      method: 'GET',
      path: '/admin/wallets/:userId/transactions',
      handler: 'wallets.getUserTransactions',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Update user wallet balance (admin action)
    {
      method: 'PUT',
      path: '/admin/wallets/:userId/balance',
      handler: 'wallets.updateWalletBalance',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Create manual transaction (admin action)
    {
      method: 'POST',
      path: '/admin/wallets/:userId/transactions',
      handler: 'wallets.createTransaction',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Wallet operations (add funds, remove funds, set balance, transfer)
    {
      method: 'POST',
      path: '/admin/wallets/:walletId/operations',
      handler: 'wallets.walletOperation',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    }
  ]
};
