'use strict';

/**
 * user-wallet service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::user-wallet.user-wallet');
