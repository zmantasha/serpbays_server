'use strict';

/**
 * Email Operations Routes
 */

module.exports = {
  routes: [
    // Webhook endpoint for incoming emails (no auth required for webhooks)
    {
      method: 'POST',
      path: '/api/email/webhook',
      handler: 'email-operations.handleIncomingEmail',
      config: {
        auth: false, // Webhooks don't have user auth
        policies: [],
        middlewares: []
      }
    },
    
    // Manual email command processing (for testing and admin use)
    {
      method: 'POST',
      path: '/api/email/process-command',
      handler: 'email-operations.processEmailCommand',
      config: {
        auth: {
          scope: [] // Require authentication
        }
      }
    },
    
    // Trigger order operation emails
    {
      method: 'POST',
      path: '/api/email/trigger-order-operation',
      handler: 'email-operations.triggerOrderOperation',
      config: {
        auth: {
          scope: [] // Require authentication
        }
      }
    },
    
    // Trigger transaction operation emails
    {
      method: 'POST',
      path: '/api/email/trigger-transaction-operation',
      handler: 'email-operations.triggerTransactionOperation',
      config: {
        auth: {
          scope: [] // Require authentication
        }
      }
    },
    
    // Get email operation statistics (admin only)
    {
      method: 'GET',
      path: '/api/email/stats',
      handler: 'email-operations.getEmailStats',
      config: {
        auth: {
          scope: [] // Require authentication, admin check is done in controller
        }
      }
    }
  ]
};
