'use strict';

/**
 * withdrawal-request router
 * DISABLED default CRUD routes to prevent conflicts with custom routes
 * All withdrawal request routes are handled by custom-withdrawal-routes.js
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

// Create router but override the create method to disable it
module.exports = createCoreRouter('api::withdrawal-request.withdrawal-request', {
  config: {
    create: {
      auth: false,
      policies: [],
      middlewares: []
    }
  },
  only: [] // Only allow no default routes
});
