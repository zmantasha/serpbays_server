/**
 * user-wallet router
 */

import { factories } from '@strapi/strapi';

export default {
  routes: [
    {
      method: 'GET',
      path: '/user-wallet/wallet',
      handler: 'user-wallet.getWallet',
      config: {
        policies: ['global::is-authenticated'],
      },
    },
    {
      method: 'POST',
      path: '/user-wallet/add-funds',
      handler: 'user-wallet.addFunds',
      config: {
        policies: ['global::is-authenticated'],
      },
    },
    {
      method: 'GET',
      path: '/user-wallet/transactions',
      handler: 'user-wallet.getTransactions',
      config: {
        policies: ['global::is-authenticated'],
      },
    },
    {
      method: 'POST',
      path: '/user-wallet/escrow',
      handler: 'user-wallet.processEscrow',
      config: {
        policies: ['global::isAuthenticated'],
      },
    },
    {
      method: 'POST',
      path: '/user-wallet/payout',
      handler: 'user-wallet.processPayout',
      config: {
        policies: ['global::isAuthenticated'],
      },
    },
  ],
};
