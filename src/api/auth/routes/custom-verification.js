'use strict';

/**
 * Custom verification routes
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/auth/send-email-confirmation',
      handler: 'custom-verification.sendVerificationEmail',
      config: {
        auth: false, // Public endpoint
        description: 'Send custom verification email',
        tags: ['Auth']
      }
    },
    {
      method: 'GET',
      path: '/auth/verify-email',
      handler: 'custom-verification.verifyEmail',
      config: {
        auth: false, // Public endpoint
        description: 'Verify email with custom token',
        tags: ['Auth']
      }
    }
  ]
};
