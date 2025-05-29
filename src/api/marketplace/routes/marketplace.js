'use strict';

/**
 * marketplace router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

// module.exports = createCoreRouter('api::marketplace.marketplace');

// Customizing the core router to add policies
module.exports = createCoreRouter('api::marketplace.marketplace', {
  config: {
    find: { 
      policies: [
        {
          name: 'global::simple-rate-limit', // Using the custom policy
          config: { // Configuration for the policy
            interval: 60000, // 1 minute
            max: 100,        // Limit each IP to 100 requests per minute for this route
          },
        },
      ],
      middlewares: [], // Middlewares array can be empty or contain other route-specific middlewares
    },
    findOne: {
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
    // You can customize other actions (create, update, delete) here as well
  }
});
