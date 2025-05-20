'use strict';

/**
 * outsourced-content router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::outsourced-content.outsourced-content', {
  config: {
    find: {
      middlewares: [
        'api::outsourced-content.is-owner'
      ]
    }
  }
}); 