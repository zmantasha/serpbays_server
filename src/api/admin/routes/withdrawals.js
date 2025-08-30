'use strict';

/**
 * Admin Withdrawals Management Routes
 */

module.exports = {
  routes: [
    // Withdrawal requests CRUD
    {
      method: 'GET',
      path: '/api/admin/withdrawals',
      handler: 'withdrawals.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/withdrawals/stats',
      handler: 'withdrawals.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/withdrawals/:id',
      handler: 'withdrawals.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/withdrawals/:id/approve',
      handler: 'withdrawals.approve',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/withdrawals/:id/reject',
      handler: 'withdrawals.reject',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/withdrawals/:id/pay',
      handler: 'withdrawals.pay',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'POST',
      path: '/api/admin/withdrawals/bulk-process',
      handler: 'withdrawals.bulkProcess',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
