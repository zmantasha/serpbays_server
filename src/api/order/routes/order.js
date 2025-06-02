'use strict';

/**
 * order router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

// Create the default router with custom configuration
const defaultRouter = createCoreRouter('api::order.order', {
  config: {
    create: {
      policies: [],
      middlewares: [],
    },
    find: {
      policies: [],
      middlewares: [],
    },
    findOne: {
      policies: [],
      middlewares: [],
    },
    update: {
      policies: [],
      middlewares: [],
    },
    delete: {
      policies: [],
      middlewares: [],
    },
  }
});

// Export the router with auth properly configured
module.exports = defaultRouter;
