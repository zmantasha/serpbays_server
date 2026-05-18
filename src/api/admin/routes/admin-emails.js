'use strict';

/**
 * Admin Emails Routes
 *
 * Exposes /admin/emails/* endpoints for the admin panel's Gmail-style
 * composer. All routes are gated by the global is-admin policy and pass
 * through the admin-logger middleware.
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/admin/emails/send',
      handler: 'admin-emails.send',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'GET',
      path: '/admin/emails',
      handler: 'admin-emails.find',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'GET',
      path: '/admin/emails/:id',
      handler: 'admin-emails.findOne',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger'],
      },
    },
  ],
};
