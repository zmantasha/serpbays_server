'use strict';

/**
 * Admin Communications Management Routes
 */

module.exports = {
  routes: [
    // Communications CRUD
    {
      method: 'GET',
      path: '/admin/communications',
      handler: 'communications.find',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/communications/stats',
      handler: 'communications.getStats',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/communications/flagged',
      handler: 'communications.getFlagged',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/communications/:id',
      handler: 'communications.findOne',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'POST',
      path: '/admin/communications/send',
      handler: 'communications.sendMessage',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/communications/:id/flag',
      handler: 'communications.flag',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/communications/:id/unflag',
      handler: 'communications.unflag',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'DELETE',
      path: '/admin/communications/:id',
      handler: 'communications.delete',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};

