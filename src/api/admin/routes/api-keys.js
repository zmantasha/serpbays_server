'use strict';

// Customer API keys (super admin), 2026-10-13.
const cfg = { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] };
module.exports = {
  routes: [
    { method: 'GET', path: '/admin/api-keys', handler: 'api-keys.list', config: cfg },
    { method: 'POST', path: '/admin/api-keys', handler: 'api-keys.create', config: cfg },
    { method: 'PUT', path: '/admin/api-keys/:id', handler: 'api-keys.update', config: cfg },
    { method: 'GET', path: '/admin/api-keys/:id/usage', handler: 'api-keys.usage', config: cfg },
  ],
};
