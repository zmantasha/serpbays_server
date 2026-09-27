'use strict';
const cfg = { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] };
module.exports = { routes: [{ method: 'GET', path: '/admin/websites/:id/insight', handler: 'website-insights.insight', config: cfg }] };
