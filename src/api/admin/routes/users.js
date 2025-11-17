'use strict';

/**
 * Admin Users Management Routes
 */

module.exports = {
  routes: [
    // Users CRUD
    {
      method: 'GET',
      path: '/admin/users',
      handler: 'users.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/users/stats',
      handler: 'users.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/admin/users/:id',
      handler: 'users.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/users/:id',
      handler: 'users.update',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/users/:id/block',
      handler: 'users.toggleBlock',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'PUT',
      path: '/admin/users/:id/confirm',
      handler: 'users.confirmUser',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'DELETE',
      path: '/admin/users/:id',
      handler: 'users.delete',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};

