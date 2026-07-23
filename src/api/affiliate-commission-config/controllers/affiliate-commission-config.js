'use strict';

/**
 * Config CRUD is admin-only and exposed via /admin/affiliate-commission-config
 * (see src/api/admin/routes/affiliate-commission-config.js). The default
 * core-controller here is intentionally empty — the singleType's own
 * public routes are disabled in ./routes/affiliate-commission-config.js.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController(
  'api::affiliate-commission-config.affiliate-commission-config'
);
