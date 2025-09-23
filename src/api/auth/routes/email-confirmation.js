'use strict';

/**
 * Custom email confirmation routes
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/auth/email-confirmation',
      handler: 'email-confirmation.emailConfirmation',
      config: {
        auth: false, // Public endpoint
        description: 'Handle email confirmation with proper error handling and redirects',
        tags: ['Auth']
      }
    },
    {
      method: 'POST',
      path: '/auth/send-email-confirmation',
      handler: 'email-confirmation.sendVerificationEmail',
      config: {
        auth: false, // Public endpoint
        description: 'Send verification email',
        tags: ['Auth']
      }
    }
  ]
};
