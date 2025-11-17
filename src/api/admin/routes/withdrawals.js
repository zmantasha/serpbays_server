'use strict';

/**
 * Admin Withdrawals Management Routes
 */

module.exports = {
  routes: [
    // Withdrawal requests CRUD
    {
      method: 'GET',
      path: '/admin/withdrawals',
      handler: 'withdrawals.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/withdrawals/stats',
      handler: 'withdrawals.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/withdrawals/:id',
      handler: 'withdrawals.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/withdrawals/:id/approve',
      handler: 'withdrawals.approve',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/withdrawals/:id/reject',
      handler: 'withdrawals.reject',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/withdrawals/:id/mark-as-paid',
      handler: 'withdrawals.markAsPaid',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'POST',
      path: '/admin/withdrawals/bulk-process',
      handler: 'withdrawals.bulkProcess',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
