'use strict';

/**
 * Admin Bulk Price Update routes.
 * All paths under /admin/marketplace/bulk-price/* gated by global::is-admin.
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/marketplace/bulk-price/publishers',
      handler: 'bulk-price.listPublishers',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'GET',
      path: '/admin/marketplace/bulk-price/eligible-count',
      handler: 'bulk-price.eligibleCount',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'POST',
      path: '/admin/marketplace/bulk-price/export',
      handler: 'bulk-price.export',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'POST',
      path: '/admin/marketplace/bulk-price/preview',
      handler: 'bulk-price.preview',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'POST',
      path: '/admin/marketplace/bulk-price/commit',
      handler: 'bulk-price.commit',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
  ],
};
