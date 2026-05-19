'use strict';

/**
 * Admin Websites Management Routes
 */

module.exports = {
  routes: [
    // Get all websites with pagination and filters
    {
      method: 'GET',
      path: '/admin/websites',
      handler: 'websites.find',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Create new website
    {
      method: 'POST',
      path: '/admin/websites',
      handler: 'websites.create',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Get website statistics
    {
      method: 'GET',
      path: '/admin/websites/stats',
      handler: 'websites.getStats',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Bulk update metrics from CSV (MUST come before :id routes)
    {
      method: 'POST',
      path: '/admin/websites/bulk-update-metrics',
      handler: 'websites.bulkUpdateMetrics',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Export websites with filters
    {
      method: 'GET',
      path: '/admin/websites/export',
      handler: 'websites.exportFiltered',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Check website conflicts
    {
      method: 'GET',
      path: '/admin/websites/check-conflict',
      handler: 'websites.checkConflict',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Bulk import (MUST come before :id routes)
    {
      method: 'POST',
      path: '/admin/websites/bulk-import',
      handler: 'websites.bulkImport',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Get bulk import progress (MUST come before :id routes)
    {
      method: 'GET',
      path: '/admin/websites/bulk-import-progress',
      handler: 'websites.getBulkImportProgress',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Get single website
    {
      method: 'GET',
      path: '/admin/websites/:id',
      handler: 'websites.findOne',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Approve website
    {
      method: 'PUT',
      path: '/admin/websites/:id/approve',
      handler: 'websites.approve',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Reject website
    {
      method: 'PUT',
      path: '/admin/websites/:id/reject',
      handler: 'websites.reject',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Delete website
    {
      method: 'DELETE',
      path: '/admin/websites/:id',
      handler: 'websites.delete',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-delete', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Bulk approve websites
    {
      method: 'POST',
      path: '/admin/websites/bulk-approve',
      handler: 'websites.bulkApprove',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Bulk reject websites
    {
      method: 'POST',
      path: '/admin/websites/bulk-reject',
      handler: 'websites.bulkReject',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Bulk delete websites
    {
      method: 'POST',
      path: '/admin/websites/bulk-delete',
      handler: 'websites.bulkDelete',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-delete', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Update website metrics
    {
      method: 'PUT',
      path: '/admin/websites/:id/metrics',
      handler: 'websites.updateMetrics',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Replace website
    {
      method: 'PUT',
      path: '/admin/websites/:id/replace',
      handler: 'websites.replaceWebsite',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    },

    // Update website (general update)
    {
      method: 'PUT',
      path: '/admin/websites/:id',
      handler: 'websites.update',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: []
      }
    }
  ]
};
