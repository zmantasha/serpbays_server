'use strict';

/**
 * Super-admin dashboard overview route.
 *
 * `auth: false` + `global::is-admin-with-jwt`: the policy validates the
 * Bearer JWT and requires role.type in (super_admin, admin). Using the
 * default users-permissions auth instead would need a permission row
 * per role, which the boot loop only seeds for the hard-coded
 * `adminRoutes` list in src/index.js.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/dashboard/overview',
      handler: 'dashboard.overview',
      config: {
        auth: false,
        policies: ['global::is-admin-with-jwt'],
        middlewares: ['global::admin-logger'],
      },
    },
  ],
};
