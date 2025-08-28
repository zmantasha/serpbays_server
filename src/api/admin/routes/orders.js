'use strict';

/**
 * Admin Orders Management Routes
 */

module.exports = {
  routes: [
    // Orders CRUD
    {
      method: 'GET',
      path: '/api/admin/orders',
      handler: 'orders.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/api/admin/orders/stats',
      handler: 'orders.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/orders/:id',
      handler: 'orders.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/orders/:id/status',
      handler: 'orders.updateStatus',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/orders/:id/assign',
      handler: 'orders.assignPublisher',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/orders/:id/cancel',
      handler: 'orders.cancelOrder',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
