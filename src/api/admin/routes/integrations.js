'use strict';
const cfg = { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] };
module.exports = { routes: [
  { method: 'GET', path: '/admin/integrations', handler: 'integrations.list', config: cfg },
  { method: 'POST', path: '/admin/integrations/dr-refresh', handler: 'integrations.drRefresh', config: cfg },
  { method: 'POST', path: '/admin/integrations/traffic-refresh', handler: 'integrations.trafficRefresh', config: cfg },
  { method: 'GET', path: '/admin/integrations/jobs/:id', handler: 'integrations.jobStatus', config: cfg },
  { method: 'GET', path: '/admin/integrations/keys', handler: 'integrations.keysList', config: cfg },
  { method: 'POST', path: '/admin/integrations/keys', handler: 'integrations.keysCreate', config: cfg },
  { method: 'PATCH', path: '/admin/integrations/keys/:id', handler: 'integrations.keysUpdate', config: cfg },
  { method: 'DELETE', path: '/admin/integrations/keys/:id', handler: 'integrations.keysDelete', config: cfg },
  { method: 'POST', path: '/admin/integrations/keys/:id/test', handler: 'integrations.keysTest', config: cfg },
  { method: 'POST', path: '/admin/integrations/alerts/:id/resolve', handler: 'integrations.alertResolve', config: cfg },
  { method: 'POST', path: '/admin/integrations/:key/test', handler: 'integrations.test', config: cfg },
] };
