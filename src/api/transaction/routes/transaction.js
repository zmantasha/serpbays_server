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
      method: 'GET',
      path: '/api/transactions/status/:id',
      handler: 'transaction.getTransactionStatus',
      config: {
        auth: false // Allow public access to check status
      }
    },
    {
      method: 'GET',
      path: '/api/api/transactions/status/:id',
      handler: 'transaction.getTransactionStatus',
      config: {
        auth: false // Allow public access to check status
      }
    },
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
    // Transaction operations (Admin only)
    {
      method: 'PUT',
      path: '/api/transactions/:id/approve',
      handler: 'transaction.approveTransaction',
      config: {
        auth: {
          scope: ['api::transaction.transaction.update']
        }
      }
    },
    {
      method: 'PUT',
      path: '/api/transactions/:id/deny',
      handler: 'transaction.denyTransaction',
      config: {
        auth: {
          scope: ['api::transaction.transaction.update']
        }
      }
    },
    {
      method: 'PUT',
      path: '/api/transactions/:id/mark-paid',
      handler: 'transaction.markTransactionPaid',
      config: {
        auth: {
          scope: ['api::transaction.transaction.update']
        }
      }
    },
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
      path: '/api/api/transactions/webhook/:gateway',
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
    },
    // PayPal payment verification (fallback)
    {
      method: 'POST',
      path: '/api/transactions/verify-paypal',
      handler: 'transaction.verifyPayPalPayment',
      config: {
        auth: {
          scope: ['api::transaction.transaction.create']
        }
      }
    },
    // PayPal specific webhook
    {
      method: 'POST',
      path: '/api/transactions/paypal-webhook',
      handler: 'paypal-webhook.handleWebhook',
      config: {
        auth: false // PayPal webhooks must be public
      }
    },
    // Razorpay specific webhook
    {
      method: 'POST',
      path: '/api/transactions/razorpay-webhook',
      handler: 'razorpay-webhook.handleWebhook',
      config: {
        auth: false // Razorpay webhooks must be public
      }
    },
    // Razorpay payment verification endpoint
    {
      method: 'POST',
      path: '/api/transactions/verify-razorpay',
      handler: 'razorpay-webhook.verifyPayment',
      config: {
        auth: {
          scope: ['api::transaction.transaction.create']
        }
      }
    },
  ]
};
