'use strict';

/**
 * Admin Website Transfer Route
 *
 * Single endpoint that flips website ownership to a chosen user.
 * No invite/accept flow — admin acts directly.
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/admin/websites/:id/transfer-ownership',
      handler: 'website-transfers.transferOwnership',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'POST',
      path: '/admin/websites/bulk-transfer-ownership',
      handler: 'website-transfers.bulkTransferOwnership',
      config: {
        policies: ['global::is-admin', { name: 'global::requires-edit', config: { pageKey: 'websites' } }],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
