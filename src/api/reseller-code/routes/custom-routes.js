'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/reseller-codes/validate/:code',
      handler: 'reseller-code.validateCode',
      config: {
        auth: false, // Public endpoint for validation
        // Rate limit: 20 requests / minute / IP. Codes are 12-char base36
        // (~62 bits entropy → infeasible to brute-force in practice), but
        // this defends against distributed-probe attempts and reduces
        // load. The handler already narrows the anonymous response to
        // {valid, message} only (no usage stats / assignee) per Pass 7.
        policies: [{ name: 'global::simple-rate-limit', config: { max: 20, interval: 60000 } }],
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
