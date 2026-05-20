'use strict';

/**
 * Admin Bulk Metric Refresh routes.
 *
 * All paths under /admin/marketplace/bulk-refresh/* gated by
 * global::is-admin (consistent with all other admin routes).
 * Export + revert + skip-site handlers come in Phase 3/4.
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/marketplace/bulk-refresh/status',
      handler: 'bulk-refresh.status',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'GET',
      path: '/admin/marketplace/bulk-refresh/profiles',
      handler: 'bulk-refresh.profiles',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'POST',
      path: '/admin/marketplace/bulk-refresh/preview',
      handler: 'bulk-refresh.preview',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'POST',
      path: '/admin/marketplace/bulk-refresh/commit',
      handler: 'bulk-refresh.commit',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'GET',
      path: '/admin/marketplace/bulk-refresh/jobs',
      handler: 'bulk-refresh.listJobs',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'GET',
      path: '/admin/marketplace/bulk-refresh/jobs/:id',
      handler: 'bulk-refresh.getJob',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'GET',
      path: '/admin/marketplace/bulk-refresh/eligible-count',
      handler: 'bulk-refresh.eligibleCount',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
    {
      method: 'POST',
      path: '/admin/marketplace/bulk-refresh/export',
      handler: 'bulk-refresh.export',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'marketplace' } }],
        middlewares: ['global::admin-logger'],
      },
    },
  ],
};
