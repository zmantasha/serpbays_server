'use strict';

// Admin review of reseller applications (2026-09-27). Page key 'reseller-applications'.
const P = (name, extra) => ({ name, config: { pageKey: 'reseller-applications', ...extra } });
module.exports = {
  routes: [
    { method: 'GET', path: '/admin/reseller-applications', handler: 'reseller-applications.list', config: { auth: false, policies: ['global::is-admin-with-jwt', P('global::requires-view')], middlewares: ['global::admin-logger'] } },
    { method: 'GET', path: '/admin/reseller-applications/:id', handler: 'reseller-applications.get', config: { auth: false, policies: ['global::is-admin-with-jwt', P('global::requires-view')], middlewares: ['global::admin-logger'] } },
    { method: 'POST', path: '/admin/reseller-applications/:id/approve', handler: 'reseller-applications.approve', config: { auth: false, policies: ['global::is-admin-with-jwt', P('global::requires-edit')], middlewares: ['global::admin-logger'] } },
    { method: 'POST', path: '/admin/reseller-applications/:id/reject', handler: 'reseller-applications.reject', config: { auth: false, policies: ['global::is-admin-with-jwt', P('global::requires-edit')], middlewares: ['global::admin-logger'] } },
    { method: 'POST', path: '/admin/reseller-applications/:id/code-limit', handler: 'reseller-applications.setCodeLimit', config: { auth: false, policies: ['global::is-admin-with-jwt', P('global::requires-edit')], middlewares: ['global::admin-logger'] } },
  ],
};
