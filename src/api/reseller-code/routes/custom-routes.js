'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/reseller-codes/validate/:code',
      handler: 'reseller-code.validateCode',
      config: {
        auth: false, // Public endpoint for validation
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'POST',
      path: '/reseller-codes/use/:code',
      handler: 'reseller-code.useCode',
      config: {
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/reseller-codes/stats/:code',
      handler: 'reseller-code.getCodeStats',
      config: {
        policies: [],
        middlewares: []
      }
    }
  ]
};
