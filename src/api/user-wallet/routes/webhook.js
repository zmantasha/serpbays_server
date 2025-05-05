'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/payments/webhook/:gateway',
      handler: 'webhook.handleWebhook',
      config: {
        auth: false, // No authentication needed for webhook callbacks
        policies: [],
        middlewares: [],
      },
    },
  ],
}; 