'use strict';

/**
 * Admin Websites Management Routes
 */

module.exports = {
  routes: [
    // Get all websites with pagination and filters
    {
      method: 'GET',
      path: '/api/admin/websites',
      handler: 'websites.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Get website statistics
    {
      method: 'GET',
      path: '/api/admin/websites/stats',
      handler: 'websites.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Bulk update metrics from CSV (MUST come before :id routes)
    {
      method: 'POST',
      path: '/api/admin/websites/bulk-update-metrics',
      handler: 'websites.bulkUpdateMetrics',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Get single website
    {
      method: 'GET',
      path: '/api/admin/websites/:id',
      handler: 'websites.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Approve website
    {
      method: 'PUT',
      path: '/api/admin/websites/:id/approve',
      handler: 'websites.approve',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Reject website
    {
      method: 'PUT',
      path: '/api/admin/websites/:id/reject',
      handler: 'websites.reject',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    },

    // Update website metrics
    {
      method: 'PUT',
      path: '/api/admin/websites/:id/metrics',
      handler: 'websites.updateMetrics',
      config: {
        policies: ['global::is-admin'],
        middlewares: []
      }
    }
  ]
};
