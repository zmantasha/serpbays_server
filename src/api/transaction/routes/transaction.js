'use strict';

/**
 * transaction router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/api/transactions',
      handler: 'transaction.find',
      config: {
        auth: {
          scope: ['api::transaction.transaction.find']
        }
      }
    },
    {
      method: 'GET',
      path: '/api/transactions/:id',
      handler: 'transaction.findOne',
      config: {
        auth: {
          scope: ['api::transaction.transaction.findOne']
        }
      }
    },
    {
      method: 'POST',
      path: '/api/transactions',
      handler: 'transaction.create',
      config: {
        auth: {
          scope: ['api::transaction.transaction.create']
        }
      }
    },
    {
      method: 'PUT',
      path: '/api/transactions/:id',
      handler: 'transaction.update',
      config: {
        auth: {
          scope: ['api::transaction.transaction.update']
        }
      }
    },
    {
      method: 'DELETE',
      path: '/api/transactions/:id',
      handler: 'transaction.delete',
      config: {
        auth: {
          scope: ['api::transaction.transaction.delete']
        }
      }
    },
    // Payment endpoints
    {
      method: 'POST',
      path: '/api/transactions/payment',
      handler: 'transaction.createPayment',
      config: {
        auth: {
          scope: ['api::transaction.transaction.create']
        }
      }
    },
    {
      method: 'POST',
      path: '/api/transactions/webhook/:gateway',
      handler: 'transaction.handleWebhook',
      config: {
        auth: false // Webhooks must be public
      }
    },
    {
      method: 'POST',
      path: '/api/transactions/pending',
      handler: 'transaction.createPendingTransaction',
      config: {
        auth: {
          scope: ['api::transaction.transaction.create']
        }
      }
    }
  ]
};
