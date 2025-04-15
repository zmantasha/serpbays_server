'use strict';

/**
 * marketplace service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::marketplace.marketplace');
