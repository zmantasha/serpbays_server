'use strict';

/**
 * Admin Shared-Lists Management Routes
 *
 * Curated, shareable site lists. Admin-only — public reads happen via
 * /api/shared-lists/:slug.
 *
 * Routes use `auth: false` paired with the admin-jwt-auth middleware so the
 * is-admin policy is the sole authorization gate (no DB-seeded permissions
 * needed).
 */

const adminConfig = {
  auth: false,
  policies: ['global::is-admin-with-jwt'],
  middlewares: ['global::admin-logger'],
};

module.exports = {
  routes: [
    { method: 'GET',    path: '/admin/shared-lists',                          handler: 'shared-lists.find',              config: adminConfig },
    { method: 'GET',    path: '/admin/shared-lists/:id',                      handler: 'shared-lists.findOne',           config: adminConfig },
    { method: 'POST',   path: '/admin/shared-lists',                          handler: 'shared-lists.create',            config: adminConfig },
    { method: 'PUT',    path: '/admin/shared-lists/:id',                      handler: 'shared-lists.update',            config: adminConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/archive',              handler: 'shared-lists.archive',           config: adminConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/duplicate',            handler: 'shared-lists.duplicate',         config: adminConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/websites',             handler: 'shared-lists.bulkAddWebsites',   config: adminConfig },
    { method: 'DELETE', path: '/admin/shared-lists/:id/websites/:websiteId',  handler: 'shared-lists.removeWebsite',     config: adminConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/share-email',          handler: 'shared-lists.shareEmail',        config: adminConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/snapshot',             handler: 'shared-lists.refreshSnapshot',   config: adminConfig },
  ],
};
