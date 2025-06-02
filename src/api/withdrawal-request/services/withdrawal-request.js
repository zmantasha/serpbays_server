'use strict';

/**
 * withdrawal-request service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::withdrawal-request.withdrawal-request');
