'use strict';

/**
 * Admin Transactions Management Routes
 */

module.exports = {
  routes: [
    // Transactions CRUD
    {
      method: 'GET',
      path: '/admin/transactions',
      handler: 'transactions.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/transactions/stats',
      handler: 'transactions.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/transactions/report',
      handler: 'transactions.generateReport',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/transactions/:id',
      handler: 'transactions.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/transactions/:id/status',
      handler: 'transactions.updateStatus',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/transactions/:id',
      handler: 'transactions.update',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/transactions/:id/approve',
      handler: 'transactions.approve',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/transactions/:id/reject',
      handler: 'transactions.reject',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};

