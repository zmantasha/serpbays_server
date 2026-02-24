'use strict';

/**
 * Default Strapi CRUD routes for offer content type
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::offer.offer');
