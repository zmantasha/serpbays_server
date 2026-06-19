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
    // Audit C9 — generic `POST /api/transactions/webhook/:gateway` and its
    // typo-duplicate `/api/api/transactions/webhook/:gateway` removed. Both
    // dispatched to `transaction.handleWebhook` (now also deleted), which:
    //  - PayPal branch: captured a body-supplied orderID with NO signature
    //    verification of any kind (free PayPal-pending capture for any caller).
    //  - Stripe branch: verified signature, but credited wallet by
    //    `existingTransaction.amount` with NO `expectedChargeCents` cross-check
    //    — re-opening the M11 baseAmount-tampering vector that the dedicated
    //    `src/api/transaction/controllers/stripe-webhook.js` had closed.
    //  - Razorpay branch: used checkout-HMAC (`verifyRazorpayPayment`) instead
    //    of the webhook-secret path; same M11 bypass as Stripe.
    // Gateway-specific routes remain (`paypal-webhook.handleWebhook` etc.).
    // Regression: `scripts/test-generic-webhook-removed.js`.
    // Audit Wave-3 Vector D — `POST /api/transactions/pending` removed.
    // The handler accepted {amount, gateway, gatewayTransactionId, walletId}
    // from the request body and created a pending tx with those values
    // verbatim. Combined with the M11 webhook grace-period (legacy rows
    // missing expectedChargeCents are warn-credit until 2026-07-16), an
    // attacker could plant a $1000 pending row matching their real $1
    // gateway payment and have the webhook credit the planted amount.
    // Cross-tree grep found ZERO frontend callers and ZERO successful
    // production hits in the 7-day backend log. Handler `createPendingTransaction`
    // is also deleted (see `controllers/transaction.js`).
    // Regression: `scripts/test-pending-tx-route-removed.js`.
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
    // Audit C4 — Manual Razorpay transaction update. Admin-only.
    // Pre-fix: `auth: { strategies: ['jwt'] }` was a JWT-presence check with
    // NO scope/role enforcement — any authenticated user could POST
    // `{order_id, status: 'success'}` to flip their pending Razorpay tx and
    // self-credit a wallet without paying. Now gated by the same
    // `is-admin` policy + `admin-jwt-auth` middleware used by the sibling
    // `cleanup-pending-razorpay` route below.
    {
      method: 'POST',
      path: '/api/transactions/manual-update-razorpay',
      handler: 'razorpay-webhook.manualUpdate',
      config: {
        auth: false,
        policies: ['global::is-admin'],
        middlewares: ['global::admin-jwt-auth']
      }
    },
    // Cleanup old pending Razorpay transactions
    {
      method: 'POST',
      path: '/api/transactions/cleanup-pending-razorpay',
      handler: 'razorpay-webhook.cleanupPendingTransactions',
      config: {
        auth: false,
        policies: ['global::is-admin'],
        middlewares: ['global::admin-jwt-auth']
      }
    },
  ]
};
