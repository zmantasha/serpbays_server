'use strict';

/**
 * marketplace router
 */

module.exports = {
  routes: [
    // Marketplace Stats (Must be before :id routes)
    {
      method: 'GET',
      path: '/marketplaces/stats',
      handler: 'marketplace.getStats',
      config: {
        policies: ['global::is-authenticated'],
        middlewares: [],
      },
    },
    // Default CRUD routes with custom policies
    {
      method: 'GET',
      path: '/marketplaces',
      handler: 'marketplace.find',
      config: {
        policies: [
          {
            name: 'global::simple-rate-limit',
            config: {
              interval: 60000,
              max: 100,
            },
          },
        ],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/marketplaces/:id',
      handler: 'marketplace.findOne',
      config: {
        policies: [
          {
            name: 'global::simple-rate-limit',
            config: {
              interval: 60000,
              max: 100,
            },
          },
        ],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/marketplaces',
      handler: 'marketplace.create',
      config: {
        policies: ['global::is-authenticated'],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/marketplaces/:id',
      handler: 'marketplace.update',
      config: {
        policies: ['global::is-authenticated'],
        middlewares: [],
      },
    },
    {
      method: 'DELETE',
      path: '/marketplaces/:id',
      handler: 'marketplace.delete',
      config: {
        policies: ['global::is-authenticated'],
        middlewares: [],
      },
    },
    // Check if domain exists in marketplace
    {
      method: 'GET',
      path: '/marketplaces/check-domain/:domain',
      handler: 'marketplace.checkDomainExists',
      config: {
        auth: false, // Make this endpoint public
        policies: [],
        middlewares: [],
      },
    },
    // Custom CSV upload route — admin-gated (hotfix-v2, 2026-06-26).
    // Pre-fix policy was `is-authenticated`, meaning any logged-in user
    // (advertisers, publishers, anyone with a Strapi JWT) could mass-
    // import marketplace listings via CSV. uploadCSV parses a CSV and
    // creates marketplace.marketplace entries; bulk-import is an admin
    // operation. Matched to the same pattern as the other 5 admin-jwt
    // routes in `routes/custom.js`.
    {
      method: 'POST',
      path: '/marketplaces/upload-csv',
      handler: 'marketplace.uploadCSV',
      config: {
        auth: false,
        policies: ['global::is-admin'],
        middlewares: ['global::admin-jwt-auth'],
      },
    },
    // TAT update route for specific website
    {
      method: 'PUT',
      path: '/marketplaces/:id/update-tat',
      handler: 'marketplace.updateTAT',
      config: {
        policies: ['global::is-authenticated'],
        middlewares: [],
      },
    },
    // Bulk TAT update route (admin only)
    {
      method: 'POST',
      path: '/marketplaces/bulk-update-tat',
      handler: 'marketplace.bulkUpdateTAT',
      config: {
        policies: ['global::is-authenticated'],
        middlewares: [],
      },
    },
    // Update history (price/metric audit trail) for a single listing
    {
      method: 'GET',
      path: '/marketplaces/:id/history',
      handler: 'marketplace.getUpdateHistory',
      config: {
        policies: ['global::is-authenticated'],
        middlewares: [],
      },
    },
  ],
};
