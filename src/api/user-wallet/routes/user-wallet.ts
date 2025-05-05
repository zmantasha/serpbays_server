/**
 * user-wallet router
 */

import { factories } from '@strapi/strapi';

export default {
  routes: [
    // Standard routes with correct API prefix
    {
      method: 'GET',
      path: '/api/user-wallets',
      handler: 'api::user-wallet.user-wallet.find',
      config: {
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/api/user-wallets/:id',
      handler: 'api::user-wallet.user-wallet.findOne',
      config: {
        policies: [],
      },
    },
    {
      method: 'POST',
      path: '/api/user-wallets',
      handler: 'api::user-wallet.user-wallet.create',
      config: {
        policies: [],
      },
    },
    {
      method: 'PUT',
      path: '/api/user-wallets/:id',
      handler: 'api::user-wallet.user-wallet.update',
      config: {
        policies: [],
      },
    },
    {
      method: 'DELETE',
      path: '/api/user-wallets/:id',
      handler: 'api::user-wallet.user-wallet.delete',
      config: {
        policies: [],
      },
    },
    
    // Custom wallet endpoint with correct API prefix
    {
      method: 'GET',
      path: '/api/wallet',
      handler: 'api::user-wallet.user-wallet.getWallet',
      config: {
        policies: [],
      },
    },
  ],
};
