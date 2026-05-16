'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/publisher-websites/check-claimable/:domain',
      handler: 'publisher-website.checkClaimable',
      config: {
        auth: false, // Public endpoint
        policies: [],
        middlewares: []
      }
    }
  ]
};
