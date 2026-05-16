'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter(
  'api::marketplace-update-history.marketplace-update-history'
);
