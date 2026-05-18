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

const PAGE_KEY = 'shared-lists';

const readConfig = {
  auth: false,
  policies: [
    'global::is-admin-with-jwt',
    { name: 'global::requires-view', config: { pageKey: PAGE_KEY } },
  ],
  middlewares: ['global::admin-logger'],
};

const writeConfig = {
  auth: false,
  policies: [
    'global::is-admin-with-jwt',
    { name: 'global::requires-edit', config: { pageKey: PAGE_KEY } },
  ],
  middlewares: ['global::admin-logger'],
};

module.exports = {
  routes: [
    { method: 'GET',    path: '/admin/shared-lists',                          handler: 'shared-lists.find',              config: readConfig  },
    { method: 'GET',    path: '/admin/shared-lists/:id',                      handler: 'shared-lists.findOne',           config: readConfig  },
    { method: 'POST',   path: '/admin/shared-lists',                          handler: 'shared-lists.create',            config: writeConfig },
    { method: 'PUT',    path: '/admin/shared-lists/:id',                      handler: 'shared-lists.update',            config: writeConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/archive',              handler: 'shared-lists.archive',           config: writeConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/duplicate',            handler: 'shared-lists.duplicate',         config: writeConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/websites',             handler: 'shared-lists.bulkAddWebsites',   config: writeConfig },
    { method: 'DELETE', path: '/admin/shared-lists/:id/websites/:websiteId',  handler: 'shared-lists.removeWebsite',     config: writeConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/share-email',          handler: 'shared-lists.shareEmail',        config: writeConfig },
    { method: 'POST',   path: '/admin/shared-lists/:id/snapshot',             handler: 'shared-lists.refreshSnapshot',   config: writeConfig },
  ],
};
