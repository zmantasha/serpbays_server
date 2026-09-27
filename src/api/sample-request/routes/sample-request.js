'use strict';

// Buyer-side sample requests (2026-09-27). Custom routes only; granted to the authenticated role at boot.
module.exports = {
  routes: [
    { method: 'POST', path: '/sample-requests', handler: 'sample-request.submit', config: { policies: [{ name: 'global::simple-rate-limit', config: { interval: 60000, max: 20 } }], middlewares: [] } },
    { method: 'GET', path: '/sample-requests/mine', handler: 'sample-request.mine', config: { policies: [], middlewares: [] } },
  ],
};
