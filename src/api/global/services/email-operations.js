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
      // const advertiserEmailData = {
      //   to: advertiserEmail,
      //   subject: `Order Created Successfully - Order #${order.id}`,
      //   html: this.generateOrderCreationTemplate(order, 'advertiser'),
      //   text: `Order #${order.id} created successfully. You will be notified when the publisher responds.`
      // };

      await Promise.all([
        strapi.plugins.email.services.email.send(publisherEmailData)
        // strapi.plugins.email.services.email.send(advertiserEmailData)
      ]);

      console.log(`Order creation emails sent for order ${order.id}`);
    } catch (error) {
      console.error('Error sending order creation emails:', error);
      throw error;
    }
  },

  /**
   * Send order rejection notification email
   */
  async sendOrderRejectionEmail(order, advertiserEmail, publisherEmail) {
    try {
      const advertiserEmailData = {
        to: advertiserEmail,
        subject: `Order Rejected - Order #${order.id}`,
        html: this.generateOrderRejectionTemplate(order, 'advertiser'),
        text: `Order #${order.id} has been rejected. Reason: ${order.rejectionReason}. Funds have been refunded to your wallet.`
      };

      // const publisherEmailData = {
      //   to: publisherEmail,
      //   subject: `Order Rejection Confirmed - Order #${order.id}`,
      //   html: this.generateOrderRejectionTemplate(order, 'publisher'),
      //   text: `Order #${order.id} rejection confirmed. The advertiser has been notified.`
      // };

      await Promise.all([
        strapi.plugins.email.services.email.send(advertiserEmailData)
        // strapi.plugins.email.services.email.send(publisherEmailData)
      ]);

      console.log(`Order rejection emails sent for order ${order.id}`);
    } catch (error) {
      console.error('Error sending order rejection emails:', error);
      throw error;
    }
  },

  /**
   * Send order acceptance notification email
   */
  async sendOrderAcceptanceEmail(order, advertiserEmail, publisherEmail) {
    try {
      const advertiserEmailData = {
        to: advertiserEmail,
        subject: `Order Accepted - Order #${order.id}`,
        html: this.generateOrderAcceptanceTemplate(order, 'advertiser'),
        text: `Order #${order.id} has been accepted by the publisher. Work will begin shortly and you'll be notified upon delivery.`
      };

      // const publisherEmailData = {
      //   to: publisherEmail,
      //   subject: `Order Acceptance Confirmed - Order #${order.id}`,
      //   html: this.generateOrderAcceptanceTemplate(order, 'publisher'),
      //   text: `Order #${order.id} acceptance confirmed. The advertiser has been notified.`
      // };

      await Promise.all([
        strapi.plugins.email.services.email.send(advertiserEmailData)
        // strapi.plugins.email.services.email.send(publisherEmailData)
      ]);

      console.log(`Order acceptance emails sent for order ${order.id}`);
    } catch (error) {
      console.error('Error sending order acceptance emails:', error);
      throw error;
    }
  },

  /**
   * Send revision request notification email
   */
  async sendRevisionRequestEmail(order, publisherEmail, advertiserEmail) {
    try {
      const publisherEmailData = {
        to: publisherEmail,
        subject: `Revision Requested - Order #${order.id}`,
        html: this.generateRevisionRequestTemplate(order, 'publisher'),
        text: `Order #${order.id} revision requested. Reason: ${order.revisionMessage}. Please complete within 5 days.`
      };

      // const advertiserEmailData = {
      //   to: advertiserEmail,
      //   subject: `Revision Request Submitted - Order #${order.id}`,
      //   html: this.generateRevisionRequestTemplate(order, 'advertiser'),
      //   text: `Your revision request for order #${order.id} has been submitted. The publisher will work on it within 5 days.`
      // };

      await Promise.all([
        strapi.plugins.email.services.email.send(publisherEmailData)
        // strapi.plugins.email.services.email.send(advertiserEmailData)
      ]);

      console.log(`Revision request emails sent for order ${order.id}`);
    } catch (error) {
      console.error('Error sending revision request emails:', error);
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
   * Send auto-approval notification to advertiser
   */
  async sendAutoApprovalEmail(order, advertiserEmail, amount) {
    try {
      const emailData = {
        to: advertiserEmail,
        subject: `Order #${order.id} Auto-Approved - Payment Released`,
        html: this.generateAutoApprovalTemplate(order, amount),
        text: `Order #${order.id} has been auto-approved after 96 hours. Payment of $${amount} has been released to the publisher.`
      };

      await strapi.plugins.email.services.email.send(emailData);
      console.log(`Auto-approval email sent for order ${order.id} to ${advertiserEmail}`);
    } catch (error) {
      console.error('Error sending auto-approval email:', error);
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
   * Send withdrawal status email
   */
  async sendWithdrawalStatusEmail(withdrawalRequest, userEmail, status, reason = null) {
    try {
      let subject, template, text;

      switch (status) {
        case 'approved':
          subject = `Withdrawal Approved - Request #${withdrawalRequest.id}`;
          template = this.generateWithdrawalApprovedTemplate(withdrawalRequest);
          text = `Your withdrawal request #${withdrawalRequest.id} for $${withdrawalRequest.amount} has been approved and will be processed soon.`;
          break;

        case 'paid':
          subject = `Payment Completed - Withdrawal #${withdrawalRequest.id}`;
          template = this.generateWithdrawalPaidTemplate(withdrawalRequest);
          text = `Your withdrawal request #${withdrawalRequest.id} for $${withdrawalRequest.amount} has been completed and paid to your account.`;
          break;

        case 'denied':
          subject = `Withdrawal Denied - Request #${withdrawalRequest.id}`;
          template = this.generateWithdrawalDeniedTemplate(withdrawalRequest, reason);
          text = `Your withdrawal request #${withdrawalRequest.id} for $${withdrawalRequest.amount} has been denied. Reason: ${reason || 'No reason provided'}`;
          break;

        default:
          throw new Error('Invalid withdrawal status');
      }

      const emailData = {
        to: userEmail,
        subject,
        html: template,
        text
      };

      await strapi.plugins.email.services.email.send(emailData);
      console.log(`Withdrawal ${status} email sent for request ${withdrawalRequest.id}`);
    } catch (error) {
      console.error('Error sending withdrawal status email:', error);
      throw error;
    }
  },

  /**
   * Send withdrawal OTP verification email
   */
  async sendWithdrawalOtpEmail(otpCode, userEmail, amount) {
    try {
      const emailData = {
        to: userEmail,
        subject: 'Serpbays - Withdrawal Verification Code',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #2563eb; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
              .content { padding: 30px; background: #f9f9f9; }
              .otp-box { background: white; padding: 30px; margin: 20px 0; border-radius: 8px; border: 2px solid #2563eb; text-align: center; }
              .otp-code { font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #2563eb; margin: 10px 0; }
              .info { background: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107; margin: 15px 0; }
              .footer { text-align: center; padding: 15px; color: #666; font-size: 12px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>Withdrawal Verification</h1>
              </div>
              <div class="content">
                <p>You have requested a withdrawal of <strong>$${amount}</strong> from your Serpbays account.</p>
                <p>Please use the following verification code to confirm your withdrawal:</p>

                <div class="otp-box">
                  <p style="margin: 0; color: #666; font-size: 14px;">Your verification code</p>
                  <div class="otp-code">${otpCode}</div>
                  <p style="margin: 0; color: #666; font-size: 13px;">This code expires in 5 minutes</p>
                </div>

                <div class="info">
                  <strong>Security Notice:</strong> If you did not request this withdrawal, please ignore this email and secure your account immediately.
                </div>
              </div>
              <div class="footer">
                <p>This is an automated message from Serpbays. Please do not reply to this email.</p>
              </div>
            </div>
          </body>
          </html>
        `,
        text: `Your Serpbays withdrawal verification code is: ${otpCode}. This code expires in 5 minutes. If you did not request this withdrawal, please ignore this email.`
      };

      await strapi.plugins.email.services.email.send(emailData);
      console.log(`Withdrawal OTP email sent to ${userEmail}`);
    } catch (error) {
      console.error('Error sending withdrawal OTP email:', error);
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
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #007bff; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 20px; background: #f9f9f9; border-radius: 0 0 8px 8px; }
          .order-details { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #007bff; }
          .button { 
            display: inline-block; 
            padding: 12px 24px; 
            background: #007bff; 
            color: white !important; 
            text-decoration: none; 
            border-radius: 6px; 
            margin: 10px 5px; 
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: background-color 0.3s;
          }
          .button:hover { background: #0056b3; }
          .button.success { background: #28a745; }
          .button.success:hover { background: #1e7e34; }
          .button.reject { background: #dc3545; }
          .button.reject:hover { background: #c82333; }
          .alert { background: #d1ecf1; border: 2px solid #007bff; padding: 20px; margin: 15px 0; border-radius: 8px; }
          .email-commands { background: #fff3cd; padding: 10px; border-radius: 5px; border-left: 4px solid #ffc107; margin: 10px 0; }
          code { background: #f8f9fa; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
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
                <strong>🎯 Action Required:</strong><br>
                <p style="margin: 15px 0;">Please review and respond to this order:</p>
                
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/publisher/available-orders" class="button" style="background: #007bff; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; display: inline-block; font-weight: bold; margin: 10px;">
                    📋 View Available Orders
                  </a>
                </div>
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
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 20px; background: #f9f9f9; border-radius: 0 0 8px 8px; }
          .order-details { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #28a745; }
          .button { 
            display: inline-block; 
            padding: 12px 24px; 
            background: #28a745; 
            color: white !important; 
            text-decoration: none; 
            border-radius: 6px; 
            margin: 10px 5px; 
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: background-color 0.3s;
          }
          .button:hover { background: #1e7e34; }
          .alert { background: #fff3cd; border: 2px solid #28a745; padding: 20px; margin: 15px 0; border-radius: 8px; }
          .email-commands { background: #fff3cd; padding: 10px; border-radius: 5px; border-left: 4px solid #ffc107; margin: 10px 0; }
          code { background: #f8f9fa; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
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
                <strong>🎯 Review Required:</strong><br>
                <p style="margin: 15px 0;">Please review the delivered order:</p>
                
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/orders/order-detail/${order.id}" class="button" style="background: #28a745; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; display: inline-block; font-weight: bold; margin: 10px;">
                    📋 View Order Details
                  </a>
                </div>
                
                <p style="margin-top: 15px; color: #666;">⏰ You have 5 business days to review the delivery.</p>
              </div>
            ` : `
              <div class="alert">
                <strong>✅ Delivery Confirmed!</strong><br>
                <p style="margin: 15px 0;">Your order has been delivered and sent to the client for review.</p>
                
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/publisher/order-detail/${order.id}" class="button" style="background: #007bff; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; display: inline-block; font-weight: bold; margin: 10px;">
                    📋 View Order Status
                  </a>
                </div>
                
                <p style="color: #666;">You will be notified when the client responds.</p>
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
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 20px; background: #f9f9f9; border-radius: 0 0 8px 8px; }
          .payment-info { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #28a745; }
          .button { 
            display: inline-block; 
            padding: 12px 24px; 
            background: #28a745; 
            color: white !important; 
            text-decoration: none; 
            border-radius: 6px; 
            margin: 10px 5px; 
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: background-color 0.3s;
          }
          .button:hover { background: #1e7e34; }
          .alert { background: #d4edda; border: 2px solid #28a745; padding: 20px; margin: 15px 0; border-radius: 8px; }
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
              <strong>🎉 Great Job!</strong><br>
              <p style="margin: 15px 0;">The client has approved your work and payment has been released to your account!</p>
              
              <div style="text-align: center; margin: 20px 0;">
                <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/publisher/earnings" class="button" style="background: #28a745; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; display: inline-block; font-weight: bold; margin: 10px;">
                  💰 View Earnings & Withdraw
                </a>
              </div>
              
              <p style="color: #666;">You can now withdraw these funds from your wallet or use them for future orders.</p>
            </div>
            
            <p style="text-align: center; margin-top: 20px; color: #666;">
              Thank you for your excellent work and for using SerpBays!<br>
              <small>Keep up the great work! 🚀</small>
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate auto-approval notification email for advertiser
   */
  generateAutoApprovalTemplate(order, amount) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #f0ad4e; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 20px; background: #f9f9f9; border-radius: 0 0 8px 8px; }
          .info-box { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #f0ad4e; }
          .button {
            display: inline-block;
            padding: 12px 24px;
            background: #5a4fcf;
            color: white !important;
            text-decoration: none;
            border-radius: 6px;
            margin: 10px 5px;
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Order Auto-Approved</h1>
          </div>
          <div class="content">
            <h2>Order #${order.id} - Auto-Approved</h2>

            <p>Your order was automatically approved because no action was taken within 96 hours of delivery.</p>

            <div class="info-box">
              <h3>Order Details:</h3>
              <p><strong>Order ID:</strong> #${order.id}</p>
              <p><strong>Amount:</strong> $${amount}</p>
              <p><strong>Delivered:</strong> ${order.deliveredDate ? new Date(order.deliveredDate).toLocaleDateString() : 'N/A'}</p>
              <p><strong>Auto-Approved:</strong> ${new Date().toLocaleDateString()}</p>
              <p><strong>Status:</strong> Payment released to publisher</p>
            </div>

            <p style="color: #666;">If you believe there is an issue with the delivered work, please contact our support team.</p>

            <div style="text-align: center; margin: 20px 0;">
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/dashboard" class="button" style="background: #5a4fcf; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; display: inline-block; font-weight: bold; margin: 10px;">
                View Dashboard
              </a>
            </div>

            <p style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
              To avoid auto-approval in the future, please review and approve or dispute delivered orders within 96 hours.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate order rejection email template
   */
  generateOrderRejectionTemplate(order, recipient) {
    const isAdvertiser = recipient === 'advertiser';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc3545; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 20px; background: #f9f9f9; border-radius: 0 0 8px 8px; }
          .order-details { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #dc3545; }
          .rejection-reason { background: #f8d7da; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #dc3545; }
          .refund-info { background: #d4edda; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #28a745; }
          .confirmation-info { background: #fff3cd; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #ffc107; }
          .button { 
            display: inline-block; 
            padding: 12px 24px; 
            background: #007bff; 
            color: white !important; 
            text-decoration: none; 
            border-radius: 6px; 
            margin: 10px 5px; 
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: background-color 0.3s;
          }
          .button:hover { background: #0056b3; }
          .button.primary { background: #007bff; }
          .button.primary:hover { background: #0056b3; }
          .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
          .detail-item { padding: 8px; background: #f8f9fa; border-radius: 4px; }
          .detail-label { font-weight: bold; color: #495057; }
          .detail-value { color: #dc3545; font-weight: 500; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${isAdvertiser ? '❌ Order Rejected' : '✅ Order Rejection Confirmed'}</h1>
          </div>
          <div class="content">
            <h2>Order #${order.id}</h2>
            
            <div class="order-details">
              <h3>📋 Order Details</h3>
              <div class="details-grid">
                <div class="detail-item">
                  <div class="detail-label">Description:</div>
                  <div class="detail-value">${order.description}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Amount:</div>
                  <div class="detail-value">$${order.totalAmount}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Website:</div>
                  <div class="detail-value">${order.website?.url || order.websiteUrl || 'N/A'}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Rejection Date:</div>
                  <div class="detail-value">${new Date(order.rejectedDate || Date.now()).toLocaleDateString()}</div>
                </div>
              </div>
              
              <div class="rejection-reason">
                <h4>🚫 Rejection Reason</h4>
                <p style="font-style: italic; margin: 10px 0; padding: 10px; background: rgba(255,255,255,0.7); border-radius: 4px;">
                  "${order.rejectionReason || 'No specific reason provided'}"
                </p>
              </div>
            </div>
            
            ${isAdvertiser ? `
              <div class="refund-info">
                <h4>💰 Automatic Refund Processed</h4>
                <p><strong>✅ Refund Status:</strong> Completed automatically</p>
                <p><strong>💳 Refunded Amount:</strong> $${order.totalAmount}</p>
                <p><strong>📅 Refund Date:</strong> ${new Date().toLocaleDateString()}</p>
                <p><strong>💼 Wallet Status:</strong> Funds available for new orders</p>
                
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/orders" class="button primary">
                    🔍 Find Other Websites
                  </a>
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/orders/order-detail/${order.id}" class="button">
                    📋 View Order Details
                  </a>
                </div>
                
                <p style="margin-top: 10px; font-weight: bold; color: #155724;">
                  The full order amount has been automatically refunded to your wallet and is available for placing new orders.
                </p>
              </div>
            ` : `
              <div class="confirmation-info">
                <h4>✅ Rejection Confirmed</h4>
                <p><strong>Status:</strong> Order rejection processed successfully</p>
                <p><strong>Advertiser Notified:</strong> Yes, via email and notification</p>
                <p><strong>Refund Processed:</strong> Automatic refund completed</p>
                
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/publisher/available-orders" class="button primary">
                    📋 View Available Orders
                  </a>
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/publisher/order-detail/${order.id}" class="button">
                    📋 View Order Details
                  </a>
                </div>
                
                <p style="color: #666;">Thank you for your honest evaluation. This helps maintain quality on our platform.</p>
              </div>
            `}
            
            <p style="text-align: center; margin-top: 20px; color: #666;">
              ${isAdvertiser ?
        'Thank you for using SerpBays! We hope to serve you better next time.<br><small>Need help finding the right publisher? Contact support@serpbays.com</small>' :
        'Thank you for maintaining quality standards on SerpBays!<br><small>For any questions: support@serpbays.com</small>'
      }
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate order acceptance email template
   */
  generateOrderAcceptanceTemplate(order, recipient) {
    const isAdvertiser = recipient === 'advertiser';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 20px; background: #f9f9f9; border-radius: 0 0 8px 8px; }
          .order-details { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #28a745; }
          .acceptance-info { background: #d4edda; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #28a745; }
          .confirmation-info { background: #d1ecf1; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #17a2b8; }
          .button { 
            display: inline-block; 
            padding: 12px 24px; 
            background: #28a745; 
            color: white !important; 
            text-decoration: none; 
            border-radius: 6px; 
            margin: 10px 5px; 
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: background-color 0.3s;
          }
          .button:hover { background: #1e7e34; }
          .button.primary { background: #007bff; }
          .button.primary:hover { background: #0056b3; }
          .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
          .detail-item { padding: 8px; background: #f8f9fa; border-radius: 4px; }
          .detail-label { font-weight: bold; color: #495057; }
          .detail-value { color: #28a745; font-weight: 500; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${isAdvertiser ? '✅ Order Accepted!' : '✅ Order Acceptance Confirmed'}</h1>
          </div>
          <div class="content">
            <h2>Order #${order.id}</h2>
            
            <div class="order-details">
              <h3>📋 Order Details</h3>
              <div class="details-grid">
                <div class="detail-item">
                  <div class="detail-label">Description:</div>
                  <div class="detail-value">${order.description}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Amount:</div>
                  <div class="detail-value">$${order.totalAmount}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Website:</div>
                  <div class="detail-value">${order.website?.url || order.websiteUrl || 'N/A'}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Acceptance Date:</div>
                  <div class="detail-value">${new Date(order.acceptedDate || Date.now()).toLocaleDateString()}</div>
                </div>
              </div>
            </div>
            
            ${isAdvertiser ? `
              <div class="acceptance-info">
                <h4>🎉 Great News!</h4>
                <p><strong>✅ Order Status:</strong> Accepted and in progress</p>
                <p><strong>👨‍💼 Publisher:</strong> Working on your order</p>
                <p><strong>⏰ Next Step:</strong> You'll be notified when the work is delivered</p>
                <p><strong>💰 Payment:</strong> Secured in escrow, will be released upon completion</p>
                
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/orders/order-detail/${order.id}" class="button">
                    📋 View Order Details
                  </a>
                </div>
                
                <p style="margin-top: 10px; font-weight: bold; color: #155724;">
                  The publisher has started working on your order and will deliver it soon!
                </p>
              </div>
            ` : `
              <div class="confirmation-info">
                <h4>✅ Acceptance Confirmed</h4>
                <p><strong>Status:</strong> Order acceptance processed successfully</p>
                <p><strong>Advertiser Notified:</strong> Yes, via email and notification</p>
                <p><strong>Payment:</strong> Secured in escrow, awaiting delivery</p>
                
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/publisher/order-detail/${order.id}" class="button primary">
                    📋 View Order Details
                  </a>
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/publisher/my-orders" class="button">
                    📋 My Orders
                  </a>
                </div>
                
                <p style="color: #666;">Remember to deliver the work on time to maintain your publisher rating!</p>
              </div>
            `}
            
            <p style="text-align: center; margin-top: 20px; color: #666;">
              ${isAdvertiser ?
        'Thank you for using SerpBays! You\'ll receive an update when the order is delivered.<br><small>Questions? Contact support@serpbays.com</small>' :
        'Thank you for accepting this order! Keep up the great work!<br><small>For any questions: support@serpbays.com</small>'
      }
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate revision request email template
   */
  generateRevisionRequestTemplate(order, recipient) {
    const isPublisher = recipient === 'publisher';
    const revisionDeadline = order.revisionDeadline ? new Date(order.revisionDeadline) : new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #ffc107; color: #212529; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 20px; background: #f9f9f9; border-radius: 0 0 8px 8px; }
          .order-details { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #ffc107; }
          .revision-request { background: #fff3cd; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #ffc107; }
          .timeline-info { background: #e2e3e5; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #6c757d; }
          .action-info { background: #d1ecf1; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #17a2b8; }
          .button { 
            display: inline-block; 
            padding: 12px 24px; 
            background: #ffc107; 
            color: #212529 !important; 
            text-decoration: none; 
            border-radius: 6px; 
            margin: 10px 5px; 
            font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: background-color 0.3s;
          }
          .button:hover { background: #e0a800; }
          .button.primary { background: #007bff; color: white !important; }
          .button.primary:hover { background: #0056b3; }
          .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
          .detail-item { padding: 8px; background: #f8f9fa; border-radius: 4px; }
          .detail-label { font-weight: bold; color: #495057; }
          .detail-value { color: #ffc107; font-weight: 500; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${isPublisher ? '🔄 Revision Requested' : '✅ Revision Request Submitted'}</h1>
          </div>
          <div class="content">
            <h2>Order #${order.id}</h2>
            
            <div class="order-details">
              <h3>📋 Order Details</h3>
              <div class="details-grid">
                <div class="detail-item">
                  <div class="detail-label">Description:</div>
                  <div class="detail-value">${order.description}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Amount:</div>
                  <div class="detail-value">$${order.totalAmount}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Website:</div>
                  <div class="detail-value">${order.website?.url || order.websiteUrl || 'N/A'}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Request Date:</div>
                  <div class="detail-value">${new Date(order.revisionRequestedAt || Date.now()).toLocaleDateString()}</div>
                </div>
              </div>
              
              <div class="revision-request">
                <h4>📝 Revision Request Details</h4>
                <p style="font-style: italic; margin: 10px 0; padding: 10px; background: rgba(255,255,255,0.7); border-radius: 4px;">
                  "${order.revisionMessage || 'Revision requested by advertiser'}"
                </p>
                <p><strong>⏰ Deadline:</strong> ${revisionDeadline.toLocaleDateString()} (5 days from request)</p>
              </div>
            </div>
            
            ${isPublisher ? `
              <div class="action-info">
                <h4>🎯 Action Required</h4>
                <p><strong>What to do next:</strong></p>
                <ul style="margin: 10px 0; padding-left: 20px;">
                  <li>Review the revision request details above</li>
                  <li>Make the necessary changes to the delivered content</li>
                  <li>Complete the revision within 5 days</li>
                  <li>Submit the revised work for review</li>
                </ul>
                
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/publisher/order-detail/${order.id}" class="button primary">
                    🔄 Start Revision
                  </a>
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/publisher/orders" class="button">
                    📋 View All Orders
                  </a>
                </div>
                
                <div class="timeline-info">
                  <h4>⏰ Important Timeline</h4>
                  <p><strong>Revision Deadline:</strong> ${revisionDeadline.toLocaleDateString()}</p>
                  <p><strong>Days Remaining:</strong> ${Math.ceil((revisionDeadline - new Date()) / (1000 * 60 * 60 * 24))} days</p>
                  <p style="color: #dc3545; font-weight: bold;">⚠️ Failure to complete within 5 days may affect your publisher rating.</p>
                </div>
              </div>
            ` : `
              <div class="action-info">
                <h4>✅ Request Submitted Successfully</h4>
                <p><strong>What happens next:</strong></p>
                <ul style="margin: 10px 0; padding-left: 20px;">
                  <li>The publisher has been notified of your revision request</li>
                  <li>They will work on the revision within 5 days</li>
                  <li>You'll receive an email when the revision is completed</li>
                  <li>You can track progress in your order dashboard</li>
                </ul>
                
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/orders/order-detail/${order.id}" class="button primary">
                    📋 Track Order Progress
                  </a>
                  <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/orders" class="button">
                    📊 View All Orders
                  </a>
                </div>
                
                <div class="timeline-info">
                  <h4>⏰ Expected Timeline</h4>
                  <p><strong>Revision Deadline:</strong> ${revisionDeadline.toLocaleDateString()}</p>
                  <p><strong>Expected Completion:</strong> Within 5 business days</p>
                  <p style="color: #28a745; font-weight: bold;">✅ You'll be notified as soon as the revision is ready for review.</p>
                </div>
              </div>
            `}
            
            <p style="text-align: center; margin-top: 20px; color: #666;">
              ${isPublisher ?
        'Thank you for maintaining quality standards on SerpBays!<br><small>For technical support: support@serpbays.com</small>' :
        'Thank you for using SerpBays! We appreciate your feedback.<br><small>Need help? Contact support@serpbays.com</small>'
      }
            </p>
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
  },

  /**
   * Generate withdrawal approved email template
   */
  generateWithdrawalApprovedTemplate(withdrawalRequest) {
    const currentDate = new Date();
    const requestDate = withdrawalRequest.createdAt ? new Date(withdrawalRequest.createdAt) : currentDate;
    const expectedPaymentDate = new Date(currentDate.getTime() + 3 * 24 * 60 * 60 * 1000);

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #28a745; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .withdrawal-details { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #28a745; }
          .processing-info { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #28a745; }
          .timeline { background: #e8f5e8; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .alert { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
          .detail-item { padding: 8px; background: #f8f9fa; border-radius: 4px; }
          .detail-label { font-weight: bold; color: #495057; }
          .detail-value { color: #28a745; font-weight: 500; }
          .next-steps { background: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Withdrawal Approved!</h1>
          </div>
          <div class="content">
            <h2>Withdrawal Request #${withdrawalRequest.id}</h2>
            
            <div class="withdrawal-details">
              <h3>📋 Approved Withdrawal Details</h3>
              <div class="details-grid">
                <div class="detail-item">
                  <div class="detail-label">Amount:</div>
                  <div class="detail-value">$${withdrawalRequest.amount}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Payment Method:</div>
                  <div class="detail-value">${withdrawalRequest.method?.toUpperCase() || 'N/A'}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Request Date:</div>
                  <div class="detail-value">${requestDate.toLocaleDateString()}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Approval Date:</div>
                  <div class="detail-value">${currentDate.toLocaleDateString()}</div>
                </div>
              </div>
              
              <div class="processing-info">
                <h4>🔄 Processing Information</h4>
                <p><strong>Reference Number:</strong> SB-WD-${withdrawalRequest.id}-${currentDate.getFullYear()}</p>
                <p><strong>Processing Status:</strong> Approved - Ready for payment</p>
                <p><strong>Estimated Processing Time:</strong> 1-3 business days</p>
              </div>
              
              ${withdrawalRequest.details && withdrawalRequest.details.email ? `
              <div class="processing-info">
                <h4>📧 Payment Destination</h4>
                <p><strong>Will be sent to:</strong> ${withdrawalRequest.details.email}</p>
                <p><strong>Payment Method:</strong> ${withdrawalRequest.method?.toUpperCase() || 'Selected method'}</p>
              </div>
              ` : ''}
              
              <div class="timeline">
                <h4>📅 Payment Timeline</h4>
                <p><strong>✅ Request Submitted:</strong> ${requestDate.toLocaleDateString()}</p>
                <p><strong>✅ Approved:</strong> ${currentDate.toLocaleDateString()}</p>
                <p><strong>🔄 Payment Processing:</strong> Next 1-3 business days</p>
                <p><strong>💰 Expected Payment:</strong> By ${expectedPaymentDate.toLocaleDateString()}</p>
              </div>
            </div>
            
            <div class="alert">
              <strong>🎉 Great News!</strong><br>
              Your withdrawal request has been approved and is now in the payment queue. 
              Our finance team will process the payment within 1-3 business days.
              You will receive a confirmation email once the payment has been sent.
            </div>
            
            <div class="next-steps">
              <h4>📋 What Happens Next?</h4>
              <ul style="margin: 10px 0; padding-left: 20px;">
                <li>Your withdrawal is queued for payment processing</li>
                <li>Payment will be sent within 1-3 business days</li>
                <li>You'll receive a payment confirmation email</li>
                <li>Funds will appear in your account within 1-3 days after payment</li>
                <li>Keep this email for your records</li>
              </ul>
            </div>
            
            <p style="text-align: center; margin-top: 20px; color: #666;">
              Thank you for using SerpBays!<br>
              <small>For questions: support@serpbays.com</small>
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate withdrawal paid email template
   */
  generateWithdrawalPaidTemplate(withdrawalRequest) {
    const currentDate = new Date();
    const requestDate = withdrawalRequest.createdAt ? new Date(withdrawalRequest.createdAt) : currentDate;
    const processingTime = Math.ceil((currentDate - requestDate) / (1000 * 60 * 60 * 24)); // Days

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #007bff; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .payment-details { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #007bff; }
          .transaction-info { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #007bff; }
          .timeline { background: #e3f2fd; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .alert { background: #d1ecf1; border: 1px solid #bee5eb; padding: 15px; margin: 10px 0; border-radius: 5px; }
          .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
          .detail-item { padding: 8px; background: #f8f9fa; border-radius: 4px; }
          .detail-label { font-weight: bold; color: #495057; }
          .detail-value { color: #007bff; font-weight: 500; }
          .highlight { background: #fff3cd; padding: 10px; border-radius: 5px; border-left: 4px solid #ffc107; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💰 Payment Completed!</h1>
          </div>
          <div class="content">
            <h2>Withdrawal #${withdrawalRequest.id}</h2>
            
            <div class="payment-details">
              <h3>💳 Payment Summary</h3>
              <div class="details-grid">
                <div class="detail-item">
                  <div class="detail-label">Amount Paid:</div>
                  <div class="detail-value">$${withdrawalRequest.amount}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Payment Method:</div>
                  <div class="detail-value">${withdrawalRequest.method?.toUpperCase() || 'N/A'}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Payment Date:</div>
                  <div class="detail-value">${currentDate.toLocaleDateString()}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Processing Time:</div>
                  <div class="detail-value">${processingTime} day${processingTime !== 1 ? 's' : ''}</div>
                </div>
              </div>
              
              ${withdrawalRequest.external_transaction_id ? `
              <div class="transaction-info">
                <h4>🔗 Transaction Information</h4>
                <p><strong>External Transaction ID:</strong> ${withdrawalRequest.external_transaction_id}</p>
                <p><strong>Reference Number:</strong> SB-WD-${withdrawalRequest.id}-${currentDate.getFullYear()}</p>
              </div>
              ` : ''}
              
              <div class="timeline">
                <h4>📅 Payment Timeline</h4>
                <p><strong>Request Submitted:</strong> ${requestDate.toLocaleDateString()}</p>
                <p><strong>Payment Processed:</strong> ${currentDate.toLocaleDateString()}</p>
                <p><strong>Expected in Account:</strong> ${new Date(currentDate.getTime() + 3 * 24 * 60 * 60 * 1000).toLocaleDateString()}</p>
              </div>
            </div>
            
            <div class="alert">
              <strong>🎉 Payment Successfully Sent!</strong><br>
              Your withdrawal has been processed and the payment has been sent to your ${withdrawalRequest.method || 'selected'} account.
              The funds should appear in your account within 1-3 business days.
            </div>
            
            ${withdrawalRequest.details && withdrawalRequest.details.email ? `
            <div class="highlight">
              <strong>📧 Payment Destination:</strong><br>
              Sent to: ${withdrawalRequest.details.email}
            </div>
            ` : ''}
            
            <div class="transaction-info">
              <h4>📋 What's Next?</h4>
              <ul style="margin: 10px 0; padding-left: 20px;">
                <li>Check your ${withdrawalRequest.method || 'payment'} account in 1-3 business days</li>
                <li>Keep this email as your payment confirmation</li>
                <li>Contact support if funds don't appear within 5 business days</li>
                <li>Your SerpBays wallet has been updated automatically</li>
              </ul>
            </div>
            
            <p style="text-align: center; margin-top: 20px; color: #666;">
              Thank you for using SerpBays!<br>
              <small>For support: support@serpbays.com</small>
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  /**
   * Generate withdrawal denied email template
   */
  generateWithdrawalDeniedTemplate(withdrawalRequest, reason) {
    const currentDate = new Date();
    const requestDate = withdrawalRequest.createdAt ? new Date(withdrawalRequest.createdAt) : currentDate;

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc3545; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .withdrawal-details { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; border: 2px solid #dc3545; }
          .denial-reason { background: #f8d7da; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #dc3545; }
          .refund-info { background: #d4edda; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #28a745; }
          .support-info { background: #e2e3e5; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #6c757d; }
          .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
          .detail-item { padding: 8px; background: #f8f9fa; border-radius: 4px; }
          .detail-label { font-weight: bold; color: #495057; }
          .detail-value { color: #dc3545; font-weight: 500; }
          .next-steps { background: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>❌ Withdrawal Denied</h1>
          </div>
          <div class="content">
            <h2>Withdrawal Request #${withdrawalRequest.id}</h2>
            
            <div class="withdrawal-details">
              <h3>📋 Withdrawal Request Details</h3>
              <div class="details-grid">
                <div class="detail-item">
                  <div class="detail-label">Amount:</div>
                  <div class="detail-value">$${withdrawalRequest.amount}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Payment Method:</div>
                  <div class="detail-value">${withdrawalRequest.method?.toUpperCase() || 'N/A'}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Request Date:</div>
                  <div class="detail-value">${requestDate.toLocaleDateString()}</div>
                </div>
                <div class="detail-item">
                  <div class="detail-label">Decision Date:</div>
                  <div class="detail-value">${currentDate.toLocaleDateString()}</div>
                </div>
              </div>
              
              <div class="denial-reason">
                <h4>🚫 Reason for Denial</h4>
                <p><strong>Admin Decision:</strong></p>
                <p style="font-style: italic; margin: 10px 0; padding: 10px; background: rgba(255,255,255,0.7); border-radius: 4px;">
                  "${reason || 'No specific reason provided'}"
                </p>
                <p><strong>Reference Number:</strong> SB-WD-${withdrawalRequest.id}-DENIED-${currentDate.getFullYear()}</p>
              </div>
            </div>

            <div class="refund-info">
              <h4>💰 Automatic Refund Processed</h4>
              <p><strong>✅ Refund Status:</strong> Completed automatically</p>
              <p><strong>💳 Refund Amount:</strong> $${withdrawalRequest.amount}</p>
              <p><strong>📅 Refund Date:</strong> ${currentDate.toLocaleDateString()}</p>
              <p><strong>💼 Wallet Status:</strong> Funds available for immediate use</p>
              <p style="margin-top: 10px; font-weight: bold; color: #155724;">
                The full withdrawal amount has been automatically refunded to your SerpBays wallet and is available for immediate use.
              </p>
            </div>
            
            <div class="next-steps">
              <h4>📋 What You Can Do Next</h4>
              <ul style="margin: 10px 0; padding-left: 20px;">
                <li>Review the denial reason above</li>
                <li>Address any issues mentioned in the denial reason</li>
                <li>Submit a new withdrawal request if appropriate</li>
                <li>Contact support if you need clarification</li>
                <li>Your wallet balance is now updated with the refunded amount</li>
              </ul>
            </div>

            <div class="support-info">
              <h4>📞 Need Help?</h4>
              <p><strong>Contact Support:</strong></p>
              <p>📧 Email: support@serpbays.com</p>
              <p>📋 Reference Number: SB-WD-${withdrawalRequest.id}-DENIED</p>
              <p>🕐 Support Hours: Monday - Friday, 9 AM - 6 PM</p>
              <p style="margin-top: 10px; font-style: italic;">
                Our support team can help clarify the denial reason and guide you on how to submit a successful withdrawal request.
              </p>
            </div>
            
            <p style="text-align: center; margin-top: 20px; color: #666;">
              Thank you for using SerpBays!<br>
              <small>We're here to help: support@serpbays.com</small>
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}));
