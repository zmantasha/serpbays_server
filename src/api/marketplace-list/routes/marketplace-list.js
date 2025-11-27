'use strict';

/**
 * marketplace-list router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/marketplace-lists',
      handler: 'marketplace-list.find',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/marketplace-lists/:id',
      handler: 'marketplace-list.findOne',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/marketplace-lists',
      handler: 'marketplace-list.create',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/marketplace-lists/:id',
      handler: 'marketplace-list.update',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'DELETE',
      path: '/marketplace-lists/:id',
      handler: 'marketplace-list.delete',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};



