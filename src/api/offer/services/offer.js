'use strict';

/**
 * Default Strapi service for offer content type
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::offer.offer');
