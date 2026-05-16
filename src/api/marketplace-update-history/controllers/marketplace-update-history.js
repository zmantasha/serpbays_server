'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController(
  'api::marketplace-update-history.marketplace-update-history'
);
