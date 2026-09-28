'use strict';
const cfg = { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] };
module.exports = { routes: [
  { method: 'GET', path: '/admin/integrations', handler: 'integrations.list', config: cfg },
  { method: 'POST', path: '/admin/integrations/dr-refresh', handler: 'integrations.drRefresh', config: cfg },
  { method: 'POST', path: '/admin/integrations/:key/test', handler: 'integrations.test', config: cfg },
] };
