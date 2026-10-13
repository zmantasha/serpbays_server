'use strict';

// CSV exports (2026-10-13). Page permission is checked in the controller per kind.
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/export/:kind',
      handler: 'export.exportCsv',
      config: { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] },
    },
  ],
};
