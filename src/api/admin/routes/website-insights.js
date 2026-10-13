'use strict';
// 2026-10-13: page permission added (was admin-only).
const cfg = { auth: false, policies: ['global::is-admin-with-jwt', { name: 'global::requires-view', config: { pageKey: 'websites' } }], middlewares: ['global::admin-logger'] };
module.exports = { routes: [{ method: 'GET', path: '/admin/websites/:id/insight', handler: 'website-insights.insight', config: cfg }] };
