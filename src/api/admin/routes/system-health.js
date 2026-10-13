'use strict';

// System health snapshot for super admins (2026-10-13).
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/system/health',
      handler: 'system-health.health',
      config: { policies: ['global::is-super-admin'], middlewares: ['global::admin-logger'] },
    },
  ],
};
