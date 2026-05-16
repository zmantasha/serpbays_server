'use strict';

const adminConfig = {
  auth: false,
  policies: ['global::is-admin-with-jwt'],
  middlewares: ['global::admin-logger'],
};

module.exports = {
  routes: [
    { method: 'GET',    path: '/admin/shared-list-templates',     handler: 'shared-list-templates.find',   config: adminConfig },
    { method: 'POST',   path: '/admin/shared-list-templates',     handler: 'shared-list-templates.create', config: adminConfig },
    { method: 'DELETE', path: '/admin/shared-list-templates/:id', handler: 'shared-list-templates.delete', config: adminConfig },
  ],
};
