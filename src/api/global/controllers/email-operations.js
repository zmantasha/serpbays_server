'use strict';

/**
 * Email Operations Controller
 * Handles incoming email webhooks and email-based operations
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::global.global', ({ strapi }) => ({

  /**
   * Webhook endpoint for incoming emails (e.g., from SendGrid, Mailgun, etc.)
   * POST /api/email/webhook
   */
  // POST /api/email/webhook — inbound from SendGrid/Mailgun.
  //
  // CRITICAL pre-fix: the handler was anonymously reachable (`auth: false`)
  // with NO signature verification and NO shared secret. The downstream
  // service flow trusted `from` as the user identity:
  //   parseEmailCommand(body.text, body.from)
  //   → executeEmailCommand(cmd, entityId, senderEmail)
  //   → strapi.db.query('users').findOne({ where: { email: senderEmail } })
  // ...and then ran CONFIRM-PAYMENT / ACCEPT / REJECT / APPROVE / DISPUTE /
  // DELIVER / COMPLETE under that user's identity. An attacker who knew an
  // advertiser's email (purchase history, marketplace scraping, leaked
  // contact) could POST:
  //   { from: 'victim@example.com', text: 'CONFIRM-PAYMENT-<orderId>' }
  // and trigger a paymentConfirmed=true write on the victim's order. Same
  // shape lets the attacker mark an order REJECTed/DISPUTEd against the
  // owner without any sign-in. The handler also dumped the full body to
  // server logs.
  //
  // Fix: require a shared HMAC-Bearer secret on every inbound webhook
  // call (configured at the email provider as a static header). Without
  // the secret, refuse the request. The provider would normally sign
  // each payload — this header-bearer approach is the minimum viable
  // authentication while a per-provider signature scheme is wired up.
  // Body log narrowed to non-PII identifiers only.
  async handleIncomingEmail(ctx) {
    try {
      // Fail-closed authentication. EMAIL_WEBHOOK_SECRET must be set.
      const expected = process.env.EMAIL_WEBHOOK_SECRET;
      if (!expected || expected.length < 16) {
        strapi.log?.error?.('[EMAIL WEBHOOK] EMAIL_WEBHOOK_SECRET not configured — refusing');
        return ctx.internalServerError('Webhook not configured');
      }
      const headerSecret = ctx.request.headers['x-webhook-secret']
        || (ctx.request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!headerSecret || headerSecret.length === 0) {
        return ctx.unauthorized('Missing webhook secret');
      }
      // Timing-safe equality.
      const crypto = require('crypto');
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(headerSecret, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        strapi.log?.warn?.(`[EMAIL WEBHOOK] invalid secret from ip=${ctx.request.ip}`);
        return ctx.unauthorized('Invalid webhook secret');
      }

      const { body } = ctx.request;

      let emailData;
      if (body.to && body.from && body.text) {
        emailData = { to: body.to, from: body.from, subject: body.subject, text: body.text, html: body.html };
      } else if (body['recipient'] && body['sender'] && body['body-plain']) {
        emailData = { to: body['recipient'], from: body['sender'], subject: body['subject'], text: body['body-plain'], html: body['body-html'] };
      } else {
        return ctx.badRequest('Invalid email webhook format');
      }

      // Lightweight log — no full body dump (was leaking PII / message content to log files).
      strapi.log?.info?.(`[EMAIL WEBHOOK] from=${emailData.from} subject=${(emailData.subject || '').slice(0, 80)}`);

      const emailService = strapi.service('api::global.email-operations');
      const result = await emailService.parseEmailCommand(emailData.text, emailData.from);

      if (result.success) {
        await this.sendConfirmationEmail(emailData.from, result.message);
      } else {
        await this.sendErrorEmail(emailData.from, result.message);
      }

      ctx.body = { success: true };
    } catch (error) {
      strapi.log?.error?.('[EMAIL WEBHOOK] handler failed', { error: error.message });
      // Generic body — do not echo error.message back to a forged caller.
      ctx.body = { success: false };
    }
  },

  /**
   * Manual email command processor (for testing)
   * POST /api/email/process-command
   */
  async processEmailCommand(ctx) {
    try {
      const { command, entityId, userEmail } = ctx.request.body;

      if (!command || !entityId || !userEmail) {
        return ctx.badRequest('Command, entityId, and userEmail are required');
      }

      const emailService = strapi.service('api::global.email-operations');
      const result = await emailService.executeEmailCommand(command, entityId, userEmail);

      ctx.body = result;
    } catch (error) {
      console.error('Error processing email command:', error);
      ctx.body = { success: false, error: error.message };
    }
  },

  /**
   * Trigger order operation emails
   * POST /api/email/trigger-order-operation
   */
  async triggerOrderOperation(ctx) {
    try {
      const { operation, orderId } = ctx.request.body;

      if (!operation || !orderId) {
        return ctx.badRequest('Operation and orderId are required');
      }

      const order = await strapi.entityService.findOne('api::order.order', orderId, {
        populate: ['advertiser', 'publisher', 'website']
      });

      if (!order) {
        return ctx.notFound('Order not found');
      }

      const emailService = strapi.service('api::global.email-operations');

      switch (operation) {
        case 'payment_required':
          await emailService.sendPaymentAcceptanceEmail(
            order.id, 
            order.totalAmount, 
            order.advertiser.email
          );
          break;

        case 'order_created':
          // Get publisher email from website
          const website = await strapi.entityService.findOne('api::marketplace.marketplace', order.website.id);
          await emailService.sendOrderCreationEmail(
            order, 
            website?.publisher_email,
            order.advertiser.email
          );
          break;

        case 'order_delivered':
          await emailService.sendOrderDeliveryEmail(
            order,
            order.advertiser.email,
            order.publisher?.email
          );
          break;

        case 'order_completed':
          await emailService.sendOrderCompletionEmail(
            order,
            order.publisher?.email,
            order.totalAmount
          );
          break;

        default:
          return ctx.badRequest('Invalid operation');
      }

      ctx.body = { success: true, message: `${operation} email sent successfully` };
    } catch (error) {
      console.error('Error triggering order operation email:', error);
      ctx.body = { success: false, error: error.message };
    }
  },

  /**
   * Trigger transaction operation emails
   * POST /api/email/trigger-transaction-operation
   */
  async triggerTransactionOperation(ctx) {
    try {
      const { operation, transactionId, reason } = ctx.request.body;

      if (!operation || !transactionId) {
        return ctx.badRequest('Operation and transactionId are required');
      }

      const transaction = await strapi.entityService.findOne('api::transaction.transaction', transactionId, {
        populate: ['users_permissions_user']
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      const emailService = strapi.service('api::global.email-operations');
      const userEmail = transaction.users_permissions_user?.email;

      if (!userEmail) {
        return ctx.badRequest('User email not found for transaction');
      }

      switch (operation) {
        case 'approve':
          await emailService.sendTransactionApprovalEmail(transaction, userEmail);
          
          // Update transaction status
          await strapi.entityService.update('api::transaction.transaction', transactionId, {
            data: { transactionStatus: 'success' }
          });
          break;

        case 'deny':
          await emailService.sendTransactionDenialEmail(transaction, userEmail, reason || 'No reason provided');
          
          // Update transaction status
          await strapi.entityService.update('api::transaction.transaction', transactionId, {
            data: { transactionStatus: 'denied' }
          });
          break;

        case 'mark_paid':
          await emailService.sendPaymentConfirmationEmail(transaction, userEmail);
          
          // Update transaction status
          await strapi.entityService.update('api::transaction.transaction', transactionId, {
            data: { transactionStatus: 'paid' }
          });
          break;

        default:
          return ctx.badRequest('Invalid operation');
      }

      ctx.body = { success: true, message: `Transaction ${operation} email sent successfully` };
    } catch (error) {
      console.error('Error triggering transaction operation email:', error);
      ctx.body = { success: false, error: error.message };
    }
  },

  /**
   * Send confirmation email
   */
  async sendConfirmationEmail(userEmail, message) {
    try {
      const emailData = {
        to: userEmail,
        subject: '✅ Command Processed Successfully - SerpBays',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #28a745; color: white; padding: 20px; text-align: center; }
              .content { padding: 20px; background: #f9f9f9; }
              .alert { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; margin: 10px 0; border-radius: 5px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>✅ Success!</h1>
              </div>
              <div class="content">
                <div class="alert">
                  <strong>Command Processed Successfully</strong><br>
                  ${message}
                </div>
                <p>Your email command has been processed successfully.</p>
                <p>Thank you for using SerpBays!</p>
              </div>
            </div>
          </body>
          </html>
        `,
        text: `Command processed successfully: ${message}`
      };

      await strapi.plugins.email.services.email.send(emailData);
    } catch (error) {
      console.error('Error sending confirmation email:', error);
    }
  },

  /**
   * Send error email
   */
  async sendErrorEmail(userEmail, message) {
    try {
      const emailData = {
        to: userEmail,
        subject: '❌ Command Error - SerpBays',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #dc3545; color: white; padding: 20px; text-align: center; }
              .content { padding: 20px; background: #f9f9f9; }
              .alert { background: #f8d7da; border: 1px solid #f5c6cb; padding: 15px; margin: 10px 0; border-radius: 5px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>❌ Command Error</h1>
              </div>
              <div class="content">
                <div class="alert">
                  <strong>Error Processing Command</strong><br>
                  ${message}
                </div>
                <p>There was an error processing your email command. Please check the format and try again.</p>
                <p><strong>Valid commands:</strong></p>
                <ul>
                  <li>CONFIRM-PAYMENT-[OrderID]</li>
                  <li>ACCEPT-[OrderID]</li>
                  <li>REJECT-[OrderID]</li>
                  <li>APPROVE-[OrderID]</li>
                  <li>DISPUTE-[OrderID]</li>
                  <li>DELIVER-[OrderID]</li>
                  <li>COMPLETE-[OrderID]</li>
                </ul>
                <p>If you continue to have issues, please contact our support team.</p>
              </div>
            </div>
          </body>
          </html>
        `,
        text: `Error processing command: ${message}`
      };

      await strapi.plugins.email.services.email.send(emailData);
    } catch (error) {
      console.error('Error sending error email:', error);
    }
  },

  /**
   * Get email operation statistics
   * GET /api/email/stats
   */
  async getEmailStats(ctx) {
    try {
      const user = ctx.state.user;
      
      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if user is admin or has special access
      const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');
      
      if (!isAdmin) {
        return ctx.forbidden('Admin access required');
      }

      // Get email operation statistics
      const orderEmailStats = await strapi.db.connection.raw(`
        SELECT 
          COUNT(*) as total_orders,
          COUNT(CASE WHEN "orderStatus" = 'pending' THEN 1 END) as pending_orders,
          COUNT(CASE WHEN "orderStatus" = 'accepted' THEN 1 END) as accepted_orders,
          COUNT(CASE WHEN "orderStatus" = 'delivered' THEN 1 END) as delivered_orders,
          COUNT(CASE WHEN "orderStatus" = 'completed' THEN 1 END) as completed_orders,
          COUNT(CASE WHEN "orderStatus" = 'rejected' THEN 1 END) as rejected_orders,
          COUNT(CASE WHEN "orderStatus" = 'disputed' THEN 1 END) as disputed_orders
        FROM orders
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
      `);

      const transactionEmailStats = await strapi.db.connection.raw(`
        SELECT 
          COUNT(*) as total_transactions,
          COUNT(CASE WHEN "transactionStatus" = 'pending' THEN 1 END) as pending_transactions,
          COUNT(CASE WHEN "transactionStatus" = 'success' THEN 1 END) as successful_transactions,
          COUNT(CASE WHEN "transactionStatus" = 'failed' THEN 1 END) as failed_transactions,
          COUNT(CASE WHEN "transactionStatus" = 'denied' THEN 1 END) as denied_transactions,
          COUNT(CASE WHEN "transactionStatus" = 'paid' THEN 1 END) as paid_transactions
        FROM transactions
        WHERE "createdAt" >= NOW() - INTERVAL '30 days'
      `);

      ctx.body = {
        success: true,
        data: {
          period: 'Last 30 days',
          orders: orderEmailStats.rows[0],
          transactions: transactionEmailStats.rows[0],
          generatedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Error getting email stats:', error);
      ctx.body = { success: false, error: error.message };
    }
  },

  /**
   * Test email operations (for development)
   * POST /api/email/test
   */
  async testEmailOperation(ctx) {
    try {
      if (process.env.NODE_ENV === 'production') {
        return ctx.forbidden('Test endpoint not available in production');
      }

      const { type, email, orderId, transactionId } = ctx.request.body;
      const emailService = strapi.service('api::global.email-operations');

      switch (type) {
        case 'payment_required':
          await emailService.sendPaymentAcceptanceEmail(orderId || 1, 100, email);
          break;
        
        case 'order_creation':
          const mockOrder = {
            id: orderId || 1,
            description: 'Test Order',
            totalAmount: 100,
            serviceType: 'Guest Post',
            websiteUrl: 'example.com',
            orderDate: new Date()
          };
          await emailService.sendOrderCreationEmail(mockOrder, email, email);
          break;
        
        case 'transaction_approval':
          const mockTransaction = {
            id: transactionId || 1,
            type: 'withdrawal',
            amount: 50
          };
          await emailService.sendTransactionApprovalEmail(mockTransaction, email);
          break;
        
        default:
          return ctx.badRequest('Invalid test type');
      }

      ctx.body = { success: true, message: `Test ${type} email sent to ${email}` };
    } catch (error) {
      console.error('Error testing email operation:', error);
      ctx.body = { success: false, error: error.message };
    }
  }

}));
