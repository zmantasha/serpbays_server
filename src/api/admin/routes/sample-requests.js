'use strict';

// Admin queue of open sample requests, grouped by listing (2026-09-27). Page key 'sample-requests'.
module.exports = {
  routes: [
    { method: 'GET', path: '/admin/sample-requests', handler: 'sample-requests.list', config: { auth: false, policies: ['global::is-admin-with-jwt', { name: 'global::requires-view', config: { pageKey: 'sample-requests' } }], middlewares: ['global::admin-logger'] } },
  ],
};
