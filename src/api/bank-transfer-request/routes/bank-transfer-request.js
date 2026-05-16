'use strict';

/**
 * Bank Transfer Request Router
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/bank-transfer-requests',
      handler: 'bank-transfer-request.create',
      config: {
        auth: {
          strategies: ['jwt']
        }
      }
    },
    {
      method: 'GET',
      path: '/bank-transfer-requests',
      handler: 'bank-transfer-request.find',
      config: {
        auth: {
          strategies: ['jwt'],
          scope: ['admin']
        }
      }
    },
    {
      method: 'PUT',
      path: '/bank-transfer-requests/:id',
      handler: 'bank-transfer-request.update',
      config: {
        auth: {
          strategies: ['jwt'],
          scope: ['admin']
        }
      }
    }
  ]
};
