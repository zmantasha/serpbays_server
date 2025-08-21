'use strict';

/**
 * Custom routes for pause/resume functionality
 */

module.exports = {
  routes: [
    {
      method: 'PUT',
      path: '/publisher-websites/:id/pause',
      handler: 'publisher-website.pauseListing',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT', 
      path: '/publisher-websites/:id/resume',
      handler: 'publisher-website.resumeListing',
      config: {
        policies: [],
        middlewares: [],
      },
    }
  ]
};
