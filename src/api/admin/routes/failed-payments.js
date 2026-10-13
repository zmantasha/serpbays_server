'use strict';

// Failed / abandoned deposits follow-up list (2026-10-13).
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/payments/failed',
      handler: 'failed-payments.failed',
      config: { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] },
    },
  ],
};
