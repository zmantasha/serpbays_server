'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::bulk-refresh-job.bulk-refresh-job');
