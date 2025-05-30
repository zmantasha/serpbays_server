'use strict';

/**
 * notification service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::notification.notification', ({ strapi }) => ({
  
  // Create a notification
  async createNotification(data) {
    try {
      console.log(`[NotificationService] Creating notification with data:`, JSON.stringify(data, null, 2));
      
      // Validate required fields
      if (!data.recipientId) {
        throw new Error('recipientId is required');
      }
      if (!data.title) {
        throw new Error('title is required');
      }
      if (!data.message) {
        throw new Error('message is required');
      }
      if (!data.type) {
        throw new Error('type is required');
      }
      if (!data.action) {
        throw new Error('action is required');
      }

      // Check notification preferences
      const controller = strapi.controller('api::notification.notification');
      const shouldSend = await controller.shouldSendNotification(data.recipientId, data.type, data.isEmail);

      if (!shouldSend) {
        console.log(`[NotificationService] Notification skipped for user ${data.recipientId} due to preferences`);
        return null;
      }
      
      const notification = await strapi.entityService.create('api::notification.notification', {
        data: {
          title: data.title,
          message: data.message,
          type: data.type,
          action: data.action,
          recipient: data.recipientId,
          relatedOrderId: data.relatedOrderId,
          relatedUserId: data.relatedUserId,
          isRead: false
        }
      });
      
      console.log(`[NotificationService] Notification created successfully: ${notification.id} for user ${data.recipientId} - Action: ${data.action}`);
      return notification;
    } catch (error) {
      console.error('[NotificationService] Error creating notification:', error);
      console.error('[NotificationService] Data that failed:', JSON.stringify(data, null, 2));
      throw error;
    }
  },

  // Create order-related notifications
  async createOrderNotification(orderId, publisherId, advertiserId, action, additionalData = {}) {
    try {
      // Determine notification type based on action
      const notificationType = 'order';
      let recipientId, title, message;

      switch (action) {
        case 'new_order':
          recipientId = publisherId;
          title = 'New Order Received';
          message = `Order #${orderId} has been placed.`;
          break;
        case 'order_accepted':
          recipientId = advertiserId;
          title = 'Order Accepted';
          message = `Your order #${orderId} has been accepted.`;
          break;
        case 'order_rejected':
          recipientId = advertiserId;
          title = 'Order Rejected';
          message = `Your order #${orderId} has been rejected by the publisher.${additionalData.reason ? ` Reason: ${additionalData.reason}` : ''}`;
          break;
        case 'order_delivered':
          recipientId = advertiserId;
          title = 'Order Delivered';
          message = `Order #${orderId} has been delivered. Please review and accept the work.`;
          break;
        case 'order_completed':
          recipientId = publisherId;
          title = 'Order Completed';
          message = `Order #${orderId} has been completed and payment has been processed.`;
          break;
        case 'revision_requested':
          recipientId = publisherId;
          title = 'Revision Requested';
          message = `The advertiser has requested a revision for order #${orderId}.${additionalData.reason ? ` Reason: ${additionalData.reason}` : ''}`;
          break;
        case 'revision_completed':
          recipientId = advertiserId;
          title = 'Revision Completed';
          message = `The revision for order #${orderId} has been completed. Please review the updated work.`;
          break;
        case 'delivery_accepted_by_advertiser':
          recipientId = publisherId;
          title = 'Delivery Accepted';
          message = `Your delivery for order #${orderId} has been accepted by the advertiser.`;
          break;
        default:
          throw new Error(`Unknown order action: ${action}`);
      }

      return await this.createNotification({
        title,
        message,
        type: notificationType,
        action,
        recipientId,
        relatedOrderId: orderId,
        isEmail: false // For in-app notification
      });
    } catch (error) {
      console.error('[NotificationService] Error creating order notification:', error);
      throw error;
    }
  },
  
  // Create payment-related notifications
  async createPaymentNotification(userId, action, amount, orderId = null) {
    try {
      const notificationType = 'payment';
      let title, message;

      switch (action) {
        case 'payment_received':
          title = 'Payment Received';
          message = `Payment of $${amount} has been received.`;
          break;
        case 'withdrawal_approved':
          title = 'Withdrawal Approved';
          message = `Your withdrawal request for $${amount} has been approved.`;
          break;
        case 'withdrawal_denied':
          title = 'Withdrawal Denied';
          message = `Your withdrawal request of $${amount} has been denied. ${additionalData.reason || ''}`;
          break;
        case 'withdrawal_paid':
          title = 'Withdrawal Paid';
          message = `Your withdrawal of $${amount} has been successfully paid out.`;
          break;
        default:
          throw new Error(`Unknown payment action: ${action}`);
      }

      return await this.createNotification({
        title,
        message,
        type: notificationType,
        action,
        recipientId: userId,
        relatedOrderId: orderId,
        isEmail: false // For in-app notification
      });
    } catch (error) {
      console.error('[NotificationService] Error creating payment notification:', error);
      throw error;
    }
  },
  
  // Create communication-related notifications
  async createCommunicationNotification(recipientId, senderId, orderId, action = 'message_received') {
    try {
      const sender = await strapi.entityService.findOne('plugin::users-permissions.user', senderId);
      
      return await this.createNotification({
        title: 'New Message',
        message: `You have received a new message from ${sender.username || sender.email}.`,
        type: 'message',
        action,
        recipientId,
        relatedOrderId: orderId,
        relatedUserId: senderId,
        isEmail: false // For in-app notification
      });
    } catch (error) {
      console.error('[NotificationService] Error creating communication notification:', error);
      throw error;
    }
  },
  
  // Create system notifications
  async createSystemNotification(userId, title, message, action = 'system_update') {
    try {
      console.log(`[NotificationService] Creating system notification - User: ${userId}, Action: ${action}`);
      
      return await this.createNotification({
        title,
        message,
        type: 'system',
        action,
        recipientId: userId
      });
    } catch (error) {
      console.error('[NotificationService] Error creating system notification:', error);
      throw error;
    }
  },
  
  // Bulk create notifications for multiple users
  async createBulkNotifications(notifications) {
    try {
      const createdNotifications = [];
      
      for (const notificationData of notifications) {
        const notification = await this.createNotification(notificationData);
        createdNotifications.push(notification);
      }
      
      console.log(`Created ${createdNotifications.length} bulk notifications`);
      return createdNotifications;
    } catch (error) {
      console.error('Error creating bulk notifications:', error);
      throw error;
    }
  },
  
  // Get notification statistics for a user
  async getUserNotificationStats(userId) {
    try {
      const total = await strapi.db.query('api::notification.notification').count({
        where: { recipient: userId }
      });
      
      const unread = await strapi.db.query('api::notification.notification').count({
        where: { recipient: userId, isRead: false }
      });
      
      const byType = await strapi.db.query('api::notification.notification').findMany({
        where: { recipient: userId },
        select: ['type'],
      });
      
      const typeStats = byType.reduce((acc, notification) => {
        acc[notification.type] = (acc[notification.type] || 0) + 1;
        return acc;
      }, {});
      
      return {
        total,
        unread,
        read: total - unread,
        byType: typeStats
      };
    } catch (error) {
      console.error('Error getting notification stats:', error);
      throw error;
    }
  }
})); 