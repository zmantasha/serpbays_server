'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService(
  'api::marketplace-update-history.marketplace-update-history'
);
