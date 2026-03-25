'use strict';

/**
 * Admin VIP Settings Routes
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/vip-settings',
      handler: 'vip-settings.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'PUT',
      path: '/admin/vip-settings',
      handler: 'vip-settings.update',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger'],
      },
    },
  ],
};
