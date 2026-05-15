'use strict';

/**
 * Controller for the bulk-refresh-job collection. Public REST is
 * intentionally not exposed — the only callers are the admin
 * bulk-refresh controller (admin/controllers/bulk-refresh.js). We
 * still need the standard factory so entityService.find/findOne work.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::bulk-refresh-job.bulk-refresh-job');
