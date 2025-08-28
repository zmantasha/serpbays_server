'use strict';

/**
 * Admin Transactions Management Routes
 */

module.exports = {
  routes: [
    // Transactions CRUD
    {
      method: 'GET',
      path: '/api/admin/transactions',
      handler: 'transactions.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/transactions/stats',
      handler: 'transactions.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/transactions/report',
      handler: 'transactions.generateReport',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/transactions/:id',
      handler: 'transactions.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/transactions/:id/status',
      handler: 'transactions.updateStatus',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/transactions/:id/approve',
      handler: 'transactions.approve',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/transactions/:id/reject',
      handler: 'transactions.reject',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
