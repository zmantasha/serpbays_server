'use strict';

// Mutual ratings (2026-09-27). Custom routes only; granted to the authenticated role at boot.
module.exports = {
  routes: [
    { method: 'POST', path: '/orders/:id/rating', handler: 'order-rating.submit', config: { policies: [{ name: 'global::simple-rate-limit', config: { interval: 60000, max: 20 } }], middlewares: [] } },
    { method: 'GET', path: '/orders/:id/ratings', handler: 'order-rating.forOrder', config: { policies: [], middlewares: [] } },
    { method: 'GET', path: '/ratings/summary/:userId', handler: 'order-rating.summary', config: { policies: [], middlewares: [] } },
    { method: 'GET', path: '/ratings/pending', handler: 'order-rating.pending', config: { policies: [], middlewares: [] } },
  ],
};
