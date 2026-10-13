'use strict';

// Resolve a disputed order: release / full refund / split (2026-10-13).
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/admin/orders/:id/resolve-dispute',
      handler: 'disputes.resolveDispute',
      config: {
        auth: false,
        policies: ['global::is-admin-with-jwt', { name: 'global::requires-edit', config: { pageKey: 'orders' } }],
        middlewares: ['global::admin-logger'],
      },
    },
  ],
};
