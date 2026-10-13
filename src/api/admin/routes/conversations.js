'use strict';

// Communications list in one call (2026-10-13). Replaces the panel fetching
// every order and then one /chatroom request per order.
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/conversations',
      handler: 'conversations.list',
      config: {
        auth: false,
        policies: ['global::is-admin-with-jwt', { name: 'global::requires-view', config: { pageKey: 'communications' } }],
        middlewares: ['global::admin-logger'],
      },
    },
  ],
};
