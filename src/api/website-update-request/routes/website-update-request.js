'use strict';

// Admin-only: approving/rejecting publisher edits is an admin action. Use the
// single-step is-admin-with-jwt policy (validates the Bearer JWT AND checks
// role.type) with auth:false, mirroring the /admin/codes routes. The older
// `default-auth + is-admin` combo depended on per-action up_permissions grants
// and ran the policy before ctx.state.user was populated.
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/website-update-requests/pending',
      handler: 'website-update-request.findPending',
      config: {
        auth: false,
        policies: ['global::is-admin-with-jwt'],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/website-update-requests/:id/approve',
      handler: 'website-update-request.approve',
      config: {
        auth: false,
        policies: ['global::is-admin-with-jwt'],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/website-update-requests/:id/reject',
      handler: 'website-update-request.reject',
      config: {
        auth: false,
        policies: ['global::is-admin-with-jwt'],
        middlewares: [],
      },
    },
  ],
};
