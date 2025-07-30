'use strict';

/**
 * withdrawal-request router
 * Disable only the CREATE route to prevent conflicts with custom routes
 * Keep other routes for proper authentication and permissions
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

// Create router but disable only the create method that conflicts
module.exports = createCoreRouter('api::withdrawal-request.withdrawal-request', {
  except: ['create'] // Disable only create route, keep find, findOne, update, delete for permissions
});
