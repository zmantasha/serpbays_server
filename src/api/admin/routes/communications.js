'use strict';

/**
 * Admin Communications Management Routes
 */

module.exports = {
  routes: [
    // Communications CRUD
    {
      method: 'GET',
      path: '/api/admin/communications',
      handler: 'communications.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/communications/stats',
      handler: 'communications.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/communications/flagged',
      handler: 'communications.getFlagged',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/communications/:id',
      handler: 'communications.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'POST',
      path: '/api/admin/communications/send',
      handler: 'communications.sendMessage',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/communications/:id/flag',
      handler: 'communications.flag',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/communications/:id/unflag',
      handler: 'communications.unflag',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'DELETE',
      path: '/api/admin/communications/:id',
      handler: 'communications.delete',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};

