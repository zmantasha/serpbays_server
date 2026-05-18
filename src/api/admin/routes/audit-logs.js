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
        policies: ['global::is-admin', { name: 'global::requires-view', config: { pageKey: 'audit-logs' } }],
        middlewares: ['global::admin-logger', 'global::admin-jwt-auth']
      }
    }
  ]
};
