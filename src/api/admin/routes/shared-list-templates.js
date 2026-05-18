'use strict';

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
    { method: 'GET',    path: '/admin/shared-list-templates',     handler: 'shared-list-templates.find',   config: readConfig  },
    { method: 'POST',   path: '/admin/shared-list-templates',     handler: 'shared-list-templates.create', config: writeConfig },
    { method: 'DELETE', path: '/admin/shared-list-templates/:id', handler: 'shared-list-templates.delete', config: writeConfig },
  ],
};
