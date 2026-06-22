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
        auth: false, // Public endpoint — anonymous resend
        // Rate limit: 5 requests / 5 minutes / IP. The handler already
        // collapses every response to {ok:true} (defeats account-existence
        // enumeration, Pass 6) and enforces a 60s per-user cooldown
        // (defeats email-bomb against legitimate accounts). This
        // per-IP cap defends against a botnet pivoting through many
        // accounts to amplify spam: even when each individual cooldown
        // resets, the IP can't request more than 5 emails per window.
        policies: [{ name: 'global::simple-rate-limit', config: { max: 5, interval: 300000 } }],
        description: 'Send verification email',
        tags: ['Auth']
      }
    }
  ]
};
