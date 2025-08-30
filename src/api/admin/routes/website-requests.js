'use strict';

/**
 * Admin Website Requests Routes
 */

module.exports = {
  routes: [
    // Get all website requests with filters and pagination
    {
      method: 'GET',
      path: '/api/admin/website-requests',
      handler: 'website-requests.find',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },

    // Get website request statistics - MUST come before :id route
    {
      method: 'GET',
      path: '/api/admin/website-requests/stats',
      handler: 'website-requests.getStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },

    // Bulk process website requests
    {
      method: 'POST',
      path: '/api/admin/website-requests/bulk-process',
      handler: 'website-requests.bulkProcess',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },

    // Get single website request details
    {
      method: 'GET',
      path: '/api/admin/website-requests/:id',
      handler: 'website-requests.findOne',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },

    // Approve website request
    {
      method: 'PUT',
      path: '/api/admin/website-requests/:id/approve',
      handler: 'website-requests.approve',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },

    // Reject website request
    {
      method: 'PUT',
      path: '/api/admin/website-requests/:id/reject',
      handler: 'website-requests.reject',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
}; 