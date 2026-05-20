'use strict';

/**
 * Admin Orders Management Routes
 */

module.exports = {
  routes: [
    // Orders CRUD
    {
      method: 'GET',
      path: '/admin/orders',
      handler: 'orders.find',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'orders' } }],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/admin/orders/stats',
      handler: 'orders.getStats',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/orders/:id',
      handler: 'orders.findOne',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/orders/:id/status',
      handler: 'orders.updateStatus',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/orders/:id/assign',
      handler: 'orders.assignPublisher',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/orders/:id/cancel',
      handler: 'orders.cancelOrder',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/orders/:id/reject',
      handler: 'orders.rejectOrder',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/orders/:id/content',
      handler: 'orders.getOrderContent',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/orders/:id/chatroom',
      handler: 'orders.getOrderChatroom',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'POST',
      path: '/admin/orders/:id/chatroom/message',
      handler: 'orders.sendMessage',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'POST',
      path: '/admin/orders/create-on-behalf',
      handler: 'orders.createOnBehalf',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-create', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
