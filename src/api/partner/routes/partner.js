'use strict';

// Customer API v1 (read-only catalog), 2026-10-13. Key checked by the api-key middleware.
const cfg = { auth: false, policies: [], middlewares: ['api::partner.api-key'] };
module.exports = {
  routes: [
    { method: 'GET', path: '/v1/sites', handler: 'partner.sites', config: cfg },
    { method: 'GET', path: '/v1/sites/:id', handler: 'partner.site', config: cfg },
    { method: 'GET', path: '/v1/categories', handler: 'partner.categories', config: cfg },
    { method: 'GET', path: '/v1/me', handler: 'partner.me', config: cfg },
    { method: 'GET', path: '/v1/docs', handler: 'partner.docs', config: { auth: false, policies: [], middlewares: [] } },
  ],
};
