'use strict';

// Sites (publisher website + listing in one view), 2026-10-13. Permissions checked in the controller.
const cfg = { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] };
module.exports = {
  routes: [
    { method: 'GET', path: '/admin/sites', handler: 'sites.list', config: cfg },
    { method: 'GET', path: '/admin/sites/counts', handler: 'sites.counts', config: cfg },
    { method: 'GET', path: '/admin/sites/export', handler: 'sites.exportCsv', config: cfg },
    { method: 'GET', path: '/admin/sites/lookup', handler: 'sites.lookup', config: cfg },
    { method: 'POST', path: '/admin/sites/bulk', handler: 'sites.bulk', config: cfg },
  ],
};
