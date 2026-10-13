'use strict';

/**
 * Admin Audit Logs Routes
 *
 * Exposes the audit-log controller under /api/admin/audit-logs behind is-admin.
 * We intentionally do NOT expose default CRUD routes — audit rows must be
 * append-only (writable only from controllers via entityService).
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/audit-logs',
      handler: 'audit-logs.find',
      config: {
        auth: false,
        // 2026-10-13: was is-admin + admin-jwt-auth middleware, but policies run
        // before route middlewares, so state.user was never set and every call
        // 403d. is-admin-with-jwt validates the token and sets state.user itself.
        policies: ['global::is-admin-with-jwt', { name: 'global::requires-view', config: { pageKey: 'audit-logs' } }],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
