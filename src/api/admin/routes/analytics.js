'use strict';

/** Admin analytics (trends + distributions). Same auth pattern as dashboard.js. */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/analytics/overview',
      handler: 'analytics.overview',
      config: { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] },
    },
  ],
};
