'use strict';

/**
 * Admin routes for the global affiliate-commission config singleton.
 * Same gating pattern as every other admin route in this app.
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/affiliate-commission-config',
      handler: 'affiliate-commission-config.get',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    {
      method: 'PUT',
      path: '/admin/affiliate-commission-config',
      handler: 'affiliate-commission-config.update',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
  ],
};
