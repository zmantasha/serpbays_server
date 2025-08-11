'use strict';

/**
 * Email Operations Service
 * Handles all project operations via email including:
 * - Accepting payments
 * - Creating orders  
 * - Delivering orders
 * - Completing orders
 * - Making transactions
 * - Denying transactions
 * - Marking transactions as paid
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::global.global', ({ strapi }) => ({
  
  /**
   * Send payment acceptance email to advertiser
   */
  async sendPaymentAcceptanceEmail(orderId, amount, userEmail) {
    try {
      const emailData = {
        to: userEmail,
        subject: `Payment Required - Order #${orderId} - $${amount}`,
        html: this.generatePaymentAcceptanceTemplate(orderId, amount),
        text: `Payment of $${amount} is required for Order #${orderId}. Reply with CONFIRM-PAYMENT-${orderId} to proceed.`
      };

      const emailResult = await strapi.plugins.email.services.email.send(emailData);
      console.log(`Payment acceptance email sent for order ${orderId}`);
      return emailResult;
    } catch (error) {
      console.error('Error sending payment acceptance email:', error);
      throw error;
    }
  },

  /**
   * Send order creation confirmation email
   */
  async sendOrderCreationEmail(order, publisherEmail, advertiserEmail) {
    try {
      // Email to publisher
      const publisherEmailData = {
        to: publisherEmail,
        subject: `New Order Received - Order #${order.id}`,
        html: this.generateOrderCreationTemplate(order, 'publisher'),
        text: `New order #${order.id} received. Reply with ACCEPT-${order.id} to accept or REJECT-${order.id} to reject.`
      };

      // Email to advertiser
      const advertiserEmailData = {
        to: advertiserEmail,
        subject: `Order Created Successfully - Order #${order.id}`,
        html: this.generateOrderCreationTemplate(order, 'advertiser'),
        text: `Order #${order.id} created successfully. You will be notified when the publisher responds.`
      };

      await Promise.all([
        strapi.plugins.email.services.email.send(publisherEmailData),
        strapi.plugins.email.services.email.send(advertiserEmailData)
      ]);

      console.log(`Order creation emails sent for order ${order.id}`);
    } catch (error) {
      console.error('Error sending order creation emails:', error);
      throw error;
    }
  },

  /**
   * Send order delivery notification email
   */
  async sendOrderDeliveryEmail(order, advertiserEmail, publisherEmail) {
    try {
      const advertiserEmailData = {
        to: advertiserEmail,
        subject: `Order Delivered - Order #${order.id}`,
        html: this.generateOrderDeliveryTemplate(order, 'advertiser'),
        text: `Order #${order.id} has been delivered. Reply with APPROVE-${order.id} to approve or DISPUTE-${order.id} to dispute.`
      };

      const publisherEmailData = {
        to: publisherEmail,
        subject: `Order Delivery Confirmed - Order #${order.id}`,
        html: this.generateOrderDeliveryTemplate(order, 'publisher'),
        text: `Order #${order.id} delivery has been sent to the client. Awaiting their approval.`
      };

      await Promise.all([
        strapi.plugins.email.services.email.send(advertiserEmailData),
        strapi.plugins.email.services.email.send(publisherEmailData)
      ]);

      console.log(`Order delivery emails sent for order ${order.id}`);
    } catch (error) {
      console.error('Error sending order delivery emails:', error);
      throw error;
    }
  },

  /**
   * Send order completion email with payment release
   */
  async sendOrderCompletionEmail(order, publisherEmail, amount) {
    try {
      const emailData = {
        to: publisherEmail,
        subject: `Payment Released - Order #${order.id} Completed`,
        html: this.generateOrderCompletionTemplate(order, amount),
        text: `Order #${order.id} has been completed. Payment of $${amount} has been released to your account.`
      };

      await strapi.plugins.email.services.email.send(emailData);
      console.log(`Order completion email sent for order ${order.id}`);
    } catch (error) {
      console.error('Error sending order completion email:', error);
      throw error;
    }
  },

  /**
   * Send transaction approval email
   */
  async sendTransactionApprovalEmail(transaction, userEmail) {
    try {
      const emailData = {
        to: userEmail,
        subject: `Transaction Approved - ${transaction.type} #${transaction.id}`,
        html: this.generateTransactionApprovalTemplate(transaction),
        text: `Your ${transaction.type} transaction #${transaction.id} for $${transaction.amount} has been approved.`
      };

      await strapi.plugins.email.services.email.send(emailData);
      console.log(`Transaction approval email sent for transaction ${transaction.id}`);
    } catch (error) {
      console.error('Error sending transaction approval email:', error);
      throw error;
    }
  },

  /**
   * Send transaction denial email
   */
  async sendTransactionDenialEmail(transaction, userEmail, reason) {
    try {
      const emailData = {
        to: userEmail,
        subject: `Transaction Denied - ${transaction.type} #${transaction.id}`,
        html: this.generateTransactionDenialTemplate(transaction, reason),
        text: `Your ${transaction.type} transaction #${transaction.id} for $${transaction.amount} has been denied. Reason: ${reason}`
      };

      await strapi.plugins.email.services.email.send(emailData);
      console.log(`Transaction denial email sent for transaction ${transaction.id}`);
    } catch (error) {
      console.error('Error sending transaction denial email:', error);
      throw error;
    }
  },

  /**
   * Send payment confirmation email
   */
  async sendPaymentConfirmationEmail(transaction, userEmail) {
    try {
      const emailData = {
        to: userEmail,
        subject: `Payment Confirmed - Transaction #${transaction.id}`,
        html: this.generatePaymentConfirmationTemplate(transaction),
        text: `Payment for transaction #${transaction.id} of $${transaction.amount} has been confirmed and processed.`
      };

      await strapi.plugins.email.services.email.send(emailData);
      console.log(`Payment confirmation email sent for transaction ${transaction.id}`);
    } catch (error) {
      console.error('Error sending payment confirmation email:', error);
      throw error;
    }
  },

  /**
   * Parse incoming email for commands
   */
  async parseEmailCommand(emailBody, senderEmail) {
    try {
      const commands = [
        'CONFIRM-PAYMENT',
        'ACCEPT',
        'REJECT', 
        'APPROVE',
        'DISPUTE',
        'DELIVER',
        'COMPLETE'
      ];

      const emailContent = emailBody.toUpperCase();
      let matchedCommand = null;
      let entityId = null;

      for (const command of commands) {
        const regex = new RegExp(`${command}-(\\d+)`, 'i');
        const match = emailContent.match(regex);
        if (match) {
          matchedCommand = command;
          entityId = parseInt(match[1]);
          break;
        }
      }

      if (matchedCommand && entityId) {
        return await this.executeEmailCommand(matchedCommand, entityId, senderEmail);
      }

      return { success: false, message: 'No valid command found in email' };
    } catch (error) {
      console.error('Error parsing email command:', error);
      return { success: false, message: 'Error processing email command' };
    }
  },

  /**
   * Execute email command
   */
  async executeEmailCommand(command, entityId, senderEmail) {
    try {
      // Find user by email
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email: senderEmail }
      });

      if (!user) {
        return { success: false, message: 'User not found' };
      }

      const ctx = { state: { user } };

      switch (command) {
        case 'CONFIRM-PAYMENT':
          return await this.handlePaymentConfirmation(entityId, user);
          
        case 'ACCEPT':
          return await this.handleOrderAcceptance(entityId, user);
          
        case 'REJECT':
          return await this.handleOrderRejection(entityId, user);
          
        case 'APPROVE':
          return await this.handleOrderApproval(entityId, user);
          
        case 'DISPUTE':
          return await this.handleOrderDispute(entityId, user);
          
        case 'DELIVER':
          return await this.handleOrderDelivery(entityId, user);
          
        case 'COMPLETE':
          return await this.handleOrderCompletion(entityId, user);
          
        default:
          return { success: false, message: 'Unknown command' };
      }
    } catch (error) {
      console.error('Error executing email command:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle payment confirmation via email
   */
  async handlePaymentConfirmation(orderId, user) {
    try {
      const order = await strapi.db.query('api::order.order').findOne({
        where: { id: orderId },
        populate: ['advertiser']
      });

      if (!order) {
        return { success: false, message: 'Order not found' };
      }

      if (order.advertiser.id !== user.id) {
        return { success: false, message: 'Not authorized to confirm payment for this order' };
      }

      // Process payment confirmation logic here
      // This would typically involve updating the order status and processing payment

      await strapi.entityService.update('api::order.order', orderId, {
        data: {
          paymentConfirmed: true,
          paymentConfirmedAt: new Date()
        }
      });

      return { success: true, message: `Payment confirmed for order #${orderId}` };
    } catch (error) {
      console.error('Error handling payment confirmation:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order acceptance via email
   */
  async handleOrderAcceptance(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.acceptOrder(ctx);
      
      if (result.data) {
        return { success: true, message: `Order #${orderId} accepted successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order acceptance:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order rejection via email
   */
  async handleOrderRejection(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        request: { body: { reason: 'Rejected via email' } },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.rejectOrder(ctx);
      
      if (result.data) {
        return { success: true, message: `Order #${orderId} rejected successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order rejection:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order approval via email
   */
  async handleOrderApproval(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.completeOrder(ctx);
      
      if (result.data) {
        return { success: true, message: `Order #${orderId} approved and completed successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order approval:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order dispute via email
   */
  async handleOrderDispute(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        request: { body: { reason: 'Disputed via email' } },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.disputeOrder(ctx);
      
      if (result.data) {
        return { success: true, message: `Order #${orderId} disputed successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order dispute:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order delivery via email
   */
  async handleOrderDelivery(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        request: { body: { proof: 'Delivered via email confirmation' } },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.deliverOrder(ctx);
      
      if (result.data) {
        return { success: true, message: `Order #${orderId} marked as delivered successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order delivery:', error);
      return { success: false, message: error.message };
    }
  },

  /**
   * Handle order completion via email
   */
  async handleOrderCompletion(orderId, user) {
    try {
      const orderController = strapi.controller('api::order.order');
      const ctx = {
        state: { user },
        params: { id: orderId },
        unauthorized: (msg) => ({ success: false, message: msg }),
        notFound: (msg) => ({ success: false, message: msg }),
        badRequest: (msg) => ({ success: false, message: msg }),
        forbidden: (msg) => ({ success: false, message: msg }),
        internalServerError: (msg) => ({ success: false, message: msg })
      };

      const result = await orderController.completeOrder(ctx);
      
      if (result.data) {
        return { success: true, message: `Order #${orderId} completed successfully`, data: result.data };
      } else {
        return result;
      }
    } catch (error) {
      console.error('Error handling order completion:', error);
      return { success: false, message: error.message };
    }
  },

  // Email Templates

  /**
   * Generate payment acceptance email template
   */
  generatePaymentAcceptanceTemplate(orderId, amount) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #007bff; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .button { display: inline-block; padding: 12px 24px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .alert { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Payment Required</h1>
          </div>
          <div class="content">
            <h2>Order #${orderId}</h2>
            <p>Hello,</p>
            <p>Your order #${orderId} has been created and requires payment of <strong>$${amount}</strong>.</p>
            
            <div class="alert">
              <strong>To confirm payment via email:</strong><br>
              Reply to this email with: <code>CONFIRM-PAYMENT-${orderId}</code>
            </div>
            
            <p>Alternatively, you can log into your dashboard to complete the payment.</p>
            
            <p>Thank you for using SerpBays!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate order creation email template
   */
  generateOrderCreationTemplate(order, recipient) {
    const isPublisher = recipient === 'publisher';
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #007bff; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .order-details { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .button { display: inline-block; padding: 12px 24px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin: 10px 5px; }
          .button.reject { background: #dc3545; }
          .alert { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${isPublisher ? 'New Order Received' : 'Order Created'}</h1>
          </div>
          <div class="content">
            <h2>Order #${order.id}</h2>
            
            <div class="order-details">
              <h3>Order Details:</h3>
              <p><strong>Description:</strong> ${order.description}</p>
              <p><strong>Amount:</strong> $${order.totalAmount}</p>
              <p><strong>Service Type:</strong> ${order.serviceType || 'Guest Post'}</p>
              <p><strong>Website:</strong> ${order.websiteUrl || 'N/A'}</p>
              <p><strong>Order Date:</strong> ${new Date(order.orderDate).toLocaleDateString()}</p>
            </div>
            
            ${isPublisher ? `
              <div class="alert">
                <strong>Action Required:</strong><br>
                To accept this order, reply with: <code>ACCEPT-${order.id}</code><br>
                To reject this order, reply with: <code>REJECT-${order.id}</code>
              </div>
            ` : `
              <div class="alert">
                <strong>Order Status:</strong> Pending Publisher Acceptance<br>
                You will be notified when the publisher responds to your order.
              </div>
            `}
            
            <p>Thank you for using SerpBays!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate order delivery email template
   */
  generateOrderDeliveryTemplate(order, recipient) {
    const isAdvertiser = recipient === 'advertiser';
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .order-details { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .alert { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Order ${isAdvertiser ? 'Delivered' : 'Delivery Confirmed'}</h1>
          </div>
          <div class="content">
            <h2>Order #${order.id}</h2>
            
            <div class="order-details">
              <h3>Delivery Information:</h3>
              <p><strong>Delivered Date:</strong> ${new Date(order.deliveredDate).toLocaleDateString()}</p>
              <p><strong>Delivery Proof:</strong> ${order.deliveryProof || 'Confirmed via email'}</p>
            </div>
            
            ${isAdvertiser ? `
              <div class="alert">
                <strong>Review Required:</strong><br>
                To approve the delivery, reply with: <code>APPROVE-${order.id}</code><br>
                To dispute the delivery, reply with: <code>DISPUTE-${order.id}</code>
              </div>
              <p>You have 5 business days to review the delivery.</p>
            ` : `
              <div class="alert">
                <strong>Status:</strong> Delivery sent to client for review<br>
                You will be notified when they respond.
              </div>
            `}
            
            <p>Thank you for using SerpBays!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate order completion email template
   */
  generateOrderCompletionTemplate(order, amount) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .payment-info { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border: 2px solid #28a745; }
          .alert { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎉 Payment Released!</h1>
          </div>
          <div class="content">
            <h2>Order #${order.id} Completed</h2>
            
            <div class="payment-info">
              <h3>💰 Payment Details:</h3>
              <p><strong>Amount Released:</strong> $${amount}</p>
              <p><strong>Release Date:</strong> ${new Date().toLocaleDateString()}</p>
              <p><strong>Status:</strong> Available for withdrawal</p>
            </div>
            
            <div class="alert">
              <strong>Great Job!</strong><br>
              The client has approved your work and payment has been released to your account.
              You can now withdraw these funds from your wallet.
            </div>
            
            <p>Thank you for your excellent work and for using SerpBays!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate transaction approval email template
   */
  generateTransactionApprovalTemplate(transaction) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .transaction-details { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Transaction Approved</h1>
          </div>
          <div class="content">
            <h2>Transaction #${transaction.id}</h2>
            
            <div class="transaction-details">
              <h3>Transaction Details:</h3>
              <p><strong>Type:</strong> ${transaction.type}</p>
              <p><strong>Amount:</strong> $${transaction.amount}</p>
              <p><strong>Status:</strong> Approved</p>
              <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            </div>
            
            <p>Your transaction has been approved and processed successfully.</p>
            <p>Thank you for using SerpBays!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate transaction denial email template
   */
  generateTransactionDenialTemplate(transaction, reason) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc3545; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .transaction-details { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .alert { background: #f8d7da; border: 1px solid #f5c6cb; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>❌ Transaction Denied</h1>
          </div>
          <div class="content">
            <h2>Transaction #${transaction.id}</h2>
            
            <div class="transaction-details">
              <h3>Transaction Details:</h3>
              <p><strong>Type:</strong> ${transaction.type}</p>
              <p><strong>Amount:</strong> $${transaction.amount}</p>
              <p><strong>Status:</strong> Denied</p>
              <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            </div>
            
            <div class="alert">
              <strong>Reason for Denial:</strong><br>
              ${reason}
            </div>
            
            <p>If you have questions about this decision, please contact our support team.</p>
            <p>Thank you for using SerpBays!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate payment confirmation email template
   */
  generatePaymentConfirmationTemplate(transaction) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #007bff; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .payment-details { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border: 2px solid #007bff; }
          .alert { background: #d1ecf1; border: 1px solid #bee5eb; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💳 Payment Confirmed</h1>
          </div>
          <div class="content">
            <h2>Transaction #${transaction.id}</h2>
            
            <div class="payment-details">
              <h3>Payment Details:</h3>
              <p><strong>Amount:</strong> $${transaction.amount}</p>
              <p><strong>Payment Date:</strong> ${new Date().toLocaleDateString()}</p>
              <p><strong>Status:</strong> Confirmed & Processed</p>
              <p><strong>Transaction ID:</strong> ${transaction.gatewayTransactionId}</p>
            </div>
            
            <div class="alert">
              <strong>Payment Successful!</strong><br>
              Your payment has been confirmed and processed. Any related orders will now proceed.
            </div>
            
            <p>Thank you for your payment and for using SerpBays!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}));
