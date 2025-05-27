'use strict';

/**
 * notification service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::notification.notification', ({ strapi }) => ({
  
  // Create a notification for a new order
  async createOrderNotification(orderId, publisherId, advertiserId, action, additionalData = {}) {
    try {
      const order = await strapi.entityService.findOne('api::order.order', orderId, {
        populate: ['publisher', 'advertiser', 'website']
      });
      
      if (!order) {
        throw new Error('Order not found');
      }
      
      let recipientId, title, message;
      
      switch (action) {
        case 'new_order':
          recipientId = publisherId;
          title = 'New Order Received';
          message = `You have received a new order from ${order.advertiser?.username || order.advertiser?.name || 'an advertiser'} for ${order.website?.url || 'your website'}.`;
          break;
          
        case 'order_accepted':
          recipientId = advertiserId;
          title = 'Order Accepted';
          message = `Your order for ${order.website?.url || 'a website'} has been accepted by ${order.publisher?.username || order.publisher?.name || 'the publisher'}.`;
          break;
          
        case 'order_rejected':
          recipientId = advertiserId;
          title = 'Order Rejected';
          message = `Your order for ${order.website?.url || 'a website'} has been rejected by ${order.publisher?.username || order.publisher?.name || 'the publisher'}.`;
          break;
          
        case 'order_delivered':
          recipientId = advertiserId;
          title = 'Order Delivered';
          message = `Your order for ${order.website?.url || 'a website'} has been delivered by ${order.publisher?.username || order.publisher?.name || 'the publisher'}. Please review and accept.`;
          break;
          
        case 'order_completed':
          recipientId = publisherId;
          title = 'Order Completed';
          message = `Your order for ${order.website?.url || 'a website'} has been accepted and completed by ${order.advertiser?.username || order.advertiser?.name || 'the advertiser'}.`;
          break;
          
        case 'revision_requested':
          recipientId = publisherId;
          title = 'Revision Requested';
          message = `${order.advertiser?.username || order.advertiser?.name || 'The advertiser'} has requested a revision for order #${orderId}.`;
          break;
          
        case 'revision_completed':
          recipientId = advertiserId;
          title = 'Revision Completed';
          message = `${order.publisher?.username || order.publisher?.name || 'The publisher'} has completed the revision for order #${orderId}. Please review.`;
          break;
          
        default:
          throw new Error(`Unknown order action: ${action}`);
      }
      
      return await this.createNotification({
        title,
        message,
        type: 'order',
        action,
        recipientId,
        relatedOrderId: orderId,
        additionalData
      });
    } catch (error) {
      console.error('Error creating order notification:', error);
      throw error;
    }
  },
  
  // Create a notification for payment events
  async createPaymentNotification(userId, action, amount, additionalData = {}) {
    try {
      let title, message;
      
      switch (action) {
        case 'payment_received':
          title = 'Payment Received';
          message = `You have received a payment of $${amount}.`;
          break;
          
        case 'withdrawal_approved':
          title = 'Withdrawal Approved';
          message = `Your withdrawal request of $${amount} has been approved and will be processed shortly.`;
          break;
          
        case 'withdrawal_denied':
          title = 'Withdrawal Denied';
          message = `Your withdrawal request of $${amount} has been denied. Please contact support for more information.`;
          break;
          
        default:
          throw new Error(`Unknown payment action: ${action}`);
      }
      
      return await this.createNotification({
        title,
        message,
        type: 'payment',
        action,
        recipientId: userId,
        additionalData: { amount, ...additionalData }
      });
    } catch (error) {
      console.error('Error creating payment notification:', error);
      throw error;
    }
  },
  
  // Create a notification for communication events
  async createCommunicationNotification(recipientId, senderId, orderId, action, additionalData = {}) {
    try {
      const sender = await strapi.entityService.findOne('plugin::users-permissions.user', senderId);
      
      let title, message;
      
      switch (action) {
        case 'message_received':
          title = 'New Message';
          message = `You have received a new message from ${sender?.username || 'a user'}.`;
          break;
          
        default:
          throw new Error(`Unknown communication action: ${action}`);
      }
      
      return await this.createNotification({
        title,
        message,
        type: 'communication',
        action,
        recipientId,
        relatedOrderId: orderId,
        relatedUserId: senderId,
        additionalData
      });
    } catch (error) {
      console.error('Error creating communication notification:', error);
      throw error;
    }
  },
  
  // Create a system notification
  async createSystemNotification(userId, title, message, additionalData = {}) {
    try {
      return await this.createNotification({
        title,
        message,
        type: 'system',
        action: 'system_update',
        recipientId: userId,
        additionalData
      });
    } catch (error) {
      console.error('Error creating system notification:', error);
      throw error;
    }
  },
  
  // Generic method to create any notification
  async createNotification(data) {
    try {
      const notification = await strapi.entityService.create('api::notification.notification', {
        data: {
          title: data.title,
          message: data.message,
          type: data.type,
          action: data.action,
          recipient: data.recipientId,
          relatedOrderId: data.relatedOrderId,
          relatedUserId: data.relatedUserId,
          data: data.additionalData,
          isRead: false
        }
      });
      
      console.log(`Notification created: ${notification.id} for user ${data.recipientId} - ${data.action}`);
      return notification;
    } catch (error) {
      console.error('Error creating notification:', error);
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