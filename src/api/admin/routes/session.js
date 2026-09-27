'use strict';
module.exports = {
  routes: [
    { method: 'POST', path: '/admin/session/refresh', handler: 'session.refresh', config: { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] } },
  ],
};
