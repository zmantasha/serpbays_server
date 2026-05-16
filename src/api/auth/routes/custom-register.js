'use strict';

/**
 * Custom registration routes
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/auth/register',
      handler: 'custom-register.register',
      config: {
        auth: false, // Public endpoint
        description: 'Register user with custom email verification',
        tags: ['Auth']
      }
    }
  ]
};