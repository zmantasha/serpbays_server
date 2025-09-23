'use strict';

/**
 * Admin website-requests routes
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/api/admin/website-requests',
      handler: 'website-requests.getWebsiteRequests',
      config: {
        policies: ['global::is-admin']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/website-requests/stats',
      handler: 'website-requests.getWebsiteRequestStats',
      config: {
        policies: ['global::is-admin']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/website-requests/:id',
      handler: 'website-requests.getWebsiteRequestById',
      config: {
        policies: ['global::is-admin']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/website-requests/:id/approve',
      handler: 'website-requests.approveWebsiteRequest',
      config: {
        policies: ['global::is-admin']
      }
    },
    {
      method: 'PUT',
      path: '/api/admin/website-requests/:id/reject',
      handler: 'website-requests.rejectWebsiteRequest',
      config: {
        policies: ['global::is-admin']
      }
    },
    {
      method: 'POST',
      path: '/api/admin/website-requests/bulk-process',
      handler: 'website-requests.bulkProcessWebsiteRequests',
      config: {
        policies: ['global::is-admin']
      }
    }
  ]
};
