'use strict';

// Order conversation extras (2026-09-27): timeline, read receipts, attachments. Granted to the authenticated role at boot.
module.exports = {
  routes: [
    { method: 'GET', path: '/chat/order/:orderId/timeline', handler: 'chat.timeline', config: { policies: [], middlewares: [] } },
    { method: 'POST', path: '/chat/order/:orderId/read', handler: 'chat.markRead', config: { policies: [], middlewares: [] } },
    { method: 'POST', path: '/chat/order/:orderId/attachments', handler: 'chat.upload', config: { policies: [{ name: 'global::simple-rate-limit', config: { interval: 60000, max: 30 } }], middlewares: [] } },
    { method: 'GET', path: '/chat/attachments/:communicationId/:index', handler: 'chat.download', config: { policies: [], middlewares: [] } },
  ],
};
