'use strict';

/**
 * Admin Marketplace Management Routes
 */

module.exports = {
  routes: [
    // Marketplace CRUD
    {
      method: 'GET',
      path: '/api/admin/marketplace',
      handler: 'marketplace.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/marketplace/stats',
      handler: 'marketplace.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/marketplace/:id',
      handler: 'marketplace.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/marketplace/:id',
      handler: 'marketplace.update',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/marketplace/:id/status',
      handler: 'marketplace.toggleStatus',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'DELETE',
      path: '/api/admin/marketplace/:id',
      handler: 'marketplace.delete',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'POST',
      path: '/api/admin/marketplace/bulk-import',
      handler: 'marketplace.bulkImport',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'POST',
      path: '/api/admin/marketplace/bulk-delete',
      handler: 'marketplace.bulkDelete',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};

