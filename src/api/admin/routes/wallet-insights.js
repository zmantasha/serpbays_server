'use strict';
const cfg = { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] };
module.exports = { routes: [
  { method: 'GET', path: '/admin/wallet-insights/directory', handler: 'wallet-insights.directory', config: cfg },
  { method: 'GET', path: '/admin/wallet-insights/:walletId', handler: 'wallet-insights.detail', config: cfg },
] };
