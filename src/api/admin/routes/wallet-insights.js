'use strict';
// 2026-10-13: page permission added (was admin-only).
const cfg = { auth: false, policies: ['global::is-admin-with-jwt', { name: 'global::requires-view', config: { pageKey: 'wallets' } }], middlewares: ['global::admin-logger'] };
module.exports = { routes: [
  { method: 'GET', path: '/admin/wallet-insights/directory', handler: 'wallet-insights.directory', config: cfg },
  { method: 'GET', path: '/admin/wallet-insights/:walletId', handler: 'wallet-insights.detail', config: cfg },
] };
