'use strict';

/**
 * marketplace router
 */

module.exports = {
  routes: [
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
    // Custom CSV upload route
    {
      method: 'POST',
      path: '/marketplaces/upload-csv',
      handler: 'marketplace.uploadCSV',
      config: {
        policies: ['global::is-authenticated'],
        middlewares: [],
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
  ],
};
