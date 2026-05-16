'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/publisher-websites/claim/:id',
      handler: 'publisher-website.claimOwnership',
      config: {
        policies: [],
        middlewares: []
      }
    }
  ]
};
