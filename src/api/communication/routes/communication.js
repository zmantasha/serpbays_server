'use strict';

/**
 * communication router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::communication.communication', {
  config: {
    find: {
      auth: {
        scope: ['api::communication.communication.find']
      },
    },
    findOne: {
      auth: {
        scope: ['api::communication.communication.findOne']
      },
    },
    create: {
      auth: {
        scope: ['api::communication.communication.create']
      },
    },
    update: {
      auth: {
        scope: ['api::communication.communication.update']
      },
    },
    delete: {
      auth: {
        scope: ['api::communication.communication.delete']
      },
    },
  }
}); 