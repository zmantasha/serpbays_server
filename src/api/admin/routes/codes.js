'use strict';

/**
 * Admin Codes Routes
 * Routes for managing codes from admin panel
 *
 * Hardened 2026-09-24 (Issue B). Every route here used to carry
 * `is-admin-with-jwt` alone, which only proves "you hold an admin JWT".
 * It never consulted pagePermissions, so any admin account — including one
 * with no permissions granted at all — could list, mint, edit and delete
 * codes, i.e. create spendable wallet credit. The codes page has always
 * been declared gateable in src/lib/admin-pages.js (hasCreate + hasDelete);
 * the routes simply never enforced it. Now they do, matching every other
 * admin route file.
 */

module.exports = {
  routes: [
    // Get all codes with filtering and pagination
    {
      method: 'GET',
      path: '/admin/codes',
      handler: 'codes.find',
      config: {
        auth: false,
        policies: [
          'global::is-admin-with-jwt',
          { name: 'global::requires-view', config: { pageKey: 'codes' } }
        ],
        middlewares: ['global::admin-logger']
      }
    },

    // Get code statistics
    {
      method: 'GET',
      path: '/admin/codes/stats',
      handler: 'codes.getStats',
      config: {
        auth: false,
        policies: [
          'global::is-admin-with-jwt',
          { name: 'global::requires-view', config: { pageKey: 'codes' } }
        ],
        middlewares: ['global::admin-logger']
      }
    },

    // Generate a new code
    {
      method: 'POST',
      path: '/admin/codes/generate',
      handler: 'codes.generateCode',
      config: {
        auth: false,
        policies: [
          'global::is-admin-with-jwt',
          { name: 'global::requires-create', config: { pageKey: 'codes' } }
        ],
        middlewares: ['global::admin-logger']
      }
    },

    // Bulk generate codes
    {
      method: 'POST',
      path: '/admin/codes/bulk-generate',
      handler: 'codes.bulkGenerateCodes',
      config: {
        auth: false,
        policies: [
          'global::is-admin-with-jwt',
          { name: 'global::requires-create', config: { pageKey: 'codes' } }
        ],
        middlewares: ['global::admin-logger']
      }
    },

    // Update code status
    {
      method: 'PUT',
      path: '/admin/codes/:id/status',
      handler: 'codes.updateStatus',
      config: {
        auth: false,
        policies: [
          'global::is-admin-with-jwt',
          { name: 'global::requires-edit', config: { pageKey: 'codes' } }
        ],
        middlewares: ['global::admin-logger']
      }
    },

    // Delete a code
    {
      method: 'DELETE',
      path: '/admin/codes/:id',
      handler: 'codes.deleteCode',
      config: {
        auth: false,
        policies: [
          'global::is-admin-with-jwt',
          { name: 'global::requires-delete', config: { pageKey: 'codes' } }
        ],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
