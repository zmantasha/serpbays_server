'use strict';

/**
 * Bank Transfer Request Router.
 *
 * SECURITY NOTE:
 *   The previous routes used `auth.scope: ['admin']` for find/update.
 *   `scope` is matched against permission *actions* in up_permissions,
 *   not role names. No permission action named "admin" exists, so the
 *   scope check failed for everyone — including super_admins. Functionally
 *   the find/update endpoints were dead. We replace the broken scope
 *   with the project's `global::is-admin` policy (role.type-based).
 *   Create stays open to any authenticated user; the controller forces
 *   userId from the JWT to defeat the prior impersonation vector.
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/bank-transfer-requests',
      handler: 'bank-transfer-request.create',
      config: {
        auth: {
          strategies: ['jwt'],
        },
      },
    },
    {
      method: 'GET',
      path: '/bank-transfer-requests',
      handler: 'bank-transfer-request.find',
      config: {
        auth: {
          strategies: ['jwt'],
        },
        policies: ['global::is-admin'],
      },
    },
    {
      method: 'PUT',
      path: '/bank-transfer-requests/:id',
      handler: 'bank-transfer-request.update',
      config: {
        auth: {
          strategies: ['jwt'],
        },
        policies: ['global::is-admin'],
      },
    },
  ],
};
