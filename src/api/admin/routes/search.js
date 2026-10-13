'use strict';

// ⌘K global search (2026-10-13). Per-group page permissions are checked in the controller.
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/search',
      handler: 'search.search',
      config: { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] },
    },
  ],
};
