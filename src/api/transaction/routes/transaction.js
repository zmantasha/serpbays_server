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
        },
        middlewares: ['plugin::global.payment-rate-limit']
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
        },
        middlewares: ['plugin::global.payment-rate-limit']
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
        auth: false // Payment verification should be public
      }
    },
    // PhonePe callback endpoint
    {
      method: 'POST',
      path: '/api/transactions/phonepe-callback',
      handler: 'phonepe-webhook.handleCallback',
      config: {
        auth: false // PhonePe callbacks must be public
      }
    },
    // PhonePe status check endpoint
    {
      method: 'POST',
      path: '/api/transactions/phonepe-status',
      handler: 'phonepe-webhook.checkStatus',
      config: {
        auth: false // Status check should be public for client polling
      }
    },
    // PhonePe redirect handler
    {
      method: 'POST',
      path: '/api/transactions/phonepe-redirect',
      handler: 'phonepe-webhook.handleRedirect',
      config: {
        auth: false // PhonePe redirects must be public
      }
    },
    // Stripe specific webhook (recommended)
    {
      method: 'POST',
      path: '/api/transactions/stripe-webhook',
      handler: 'stripe-webhook.handleWebhook',
      config: {
        auth: false // Stripe webhooks must be public
      }
    },
    // Manual Stripe transaction failure (for debugging)
    {
      method: 'POST',
      path: '/api/transactions/stripe-mark-failed',
      handler: 'stripe-webhook.markTransactionFailed',
      config: {
        auth: {
          scope: ['api::transaction.transaction.update']
        }
      }
    },
    // Check Stripe transaction status (for pending transactions)
    {
      method: 'POST',
      path: '/api/transactions/stripe-check-status',
      handler: 'stripe-webhook.checkTransactionStatus',
      config: {
        auth: {
          scope: ['api::transaction.transaction.find']
        }
      }
    },
    // Manual Razorpay transaction update (for admin use)
    {
      method: 'POST',
      path: '/api/transactions/manual-update-razorpay',
      handler: 'razorpay-webhook.manualUpdate',
      config: {
        auth: {
          strategies: ['jwt']
        }
      }
    },
    // Cleanup old pending Razorpay transactions
    {
      method: 'POST',
      path: '/api/transactions/cleanup-pending-razorpay',
      handler: 'razorpay-webhook.cleanupPendingTransactions',
      config: {
        auth: false // Can be called by cron job or admin
      }
    },
  ]
};
