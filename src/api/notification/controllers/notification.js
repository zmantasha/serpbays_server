'use strict';

/**
 * notification controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::notification.notification', ({ strapi }) => ({
  
  // Get notifications for the current user
  async getMyNotifications(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;
      const { type, isRead, action, limit = 50, offset = 0 } = ctx.query;
      
      // Build filters
      const filters = {
        recipient: { id: userId }
      };
      
      if (type) {
        filters.type = type;
      }
      
      if (isRead !== undefined) {
        filters.isRead = isRead === 'true';
      }
      
      if (action) {
        filters.action = action;
      }
      
      console.log(`[NotificationController] getMyNotifications for user ${userId} with filters:`, JSON.stringify(filters, null, 2));
      
      // Get notifications
      const notifications = await strapi.entityService.findMany('api::notification.notification', {
        filters,
        sort: { createdAt: 'desc' },
        limit: parseInt(limit),
        start: parseInt(offset),
        populate: ['recipient']
      });
      
      console.log(`[NotificationController] Raw notifications from DB for user ${userId}:`, JSON.stringify(notifications, null, 2));
      console.log(`Retrieved ${notifications.length} notifications for user ${userId}`);
      
      return {
        data: notifications,
        meta: {
          count: notifications.length
        }
      };
    } catch (error) {
      console.error('Error fetching notifications:', error);
      return ctx.internalServerError('An error occurred while fetching notifications');
    }
  },
  
  // Mark a notification as read
  async markAsRead(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const { id } = ctx.params;
      const userId = ctx.state.user.id;
      
      // Get the notification and verify ownership
      const notification = await strapi.entityService.findOne('api::notification.notification', id, {
        populate: ['recipient']
      });
      
      if (!notification) {
        return ctx.notFound('Notification not found');
      }
      
      if (notification.recipient.id !== userId) {
        return ctx.forbidden('You can only mark your own notifications as read');
      }
      
      // Update the notification
      const updatedNotification = await strapi.entityService.update('api::notification.notification', id, {
        data: {
          isRead: true
        }
      });
      
      console.log(`Notification ${id} marked as read by user ${userId}`);
      
      return {
        data: updatedNotification,
        meta: {
          message: 'Notification marked as read'
        }
      };
    } catch (error) {
      console.error('Error marking notification as read:', error);
      return ctx.internalServerError('An error occurred while marking notification as read');
    }
  },
  
  // Mark all notifications as read for the current user
  async markAllAsRead(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;
      
      // Get all unread notifications for the user
      const unreadNotifications = await strapi.entityService.findMany('api::notification.notification', {
        filters: {
          recipient: { id: userId },
          isRead: false
        }
      });
      
      // Update all unread notifications
      const updatePromises = unreadNotifications.map(notification =>
        strapi.entityService.update('api::notification.notification', notification.id, {
          data: { isRead: true }
        })
      );
      
      await Promise.all(updatePromises);
      
      console.log(`Marked ${unreadNotifications.length} notifications as read for user ${userId}`);
      
      return {
        data: { updatedCount: unreadNotifications.length },
        meta: {
          message: `${unreadNotifications.length} notifications marked as read`
        }
      };
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
      return ctx.internalServerError('An error occurred while marking all notifications as read');
    }
  },
  
  // Delete a notification
  async deleteNotification(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const { id } = ctx.params;
      const userId = ctx.state.user.id;
      
      // Get the notification and verify ownership
      const notification = await strapi.entityService.findOne('api::notification.notification', id, {
        populate: ['recipient']
      });
      
      if (!notification) {
        return ctx.notFound('Notification not found');
      }
      
      if (notification.recipient.id !== userId) {
        return ctx.forbidden('You can only delete your own notifications');
      }
      
      // Delete the notification
      await strapi.entityService.delete('api::notification.notification', id);
      
      console.log(`Notification ${id} deleted by user ${userId}`);
      
      return {
        data: { id },
        meta: {
          message: 'Notification deleted successfully'
        }
      };
    } catch (error) {
      console.error('Error deleting notification:', error);
      return ctx.internalServerError('An error occurred while deleting notification');
    }
  },
  
  // Get unread notification count
  async getUnreadCount(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;
      
      // Count unread notifications
      const count = await strapi.db.query('api::notification.notification').count({
        where: {
          recipient: userId,
          isRead: false
        }
      });
      
      return {
        count
      };
    } catch (error) {
      console.error('Error getting unread count:', error);
      return ctx.internalServerError('An error occurred while getting unread count');
    }
  },
  
  // Create a test notification (for development)
  async createTestNotification(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const { title, message, type, action, relatedOrderId } = ctx.request.body;
      const userId = ctx.state.user.id;
      
      // Create the notification
      const notification = await strapi.entityService.create('api::notification.notification', {
        data: {
          title: title || 'Test Notification',
          message: message || 'This is a test notification to verify the system is working.',
          type: type || 'system',
          action: action || 'system_update',
          relatedOrderId,
          recipient: userId,
          isRead: false
        }
      });
      
      console.log(`Test notification created for user ${userId}:`, notification.id);
      
      return {
        data: notification,
        meta: {
          message: 'Test notification created successfully'
        }
      };
    } catch (error) {
      console.error('Error creating test notification:', error);
      return ctx.internalServerError('An error occurred while creating test notification');
    }
  },

  // Test order notification creation
  async testOrderNotification(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const { orderId, action = 'new_order' } = ctx.request.body;
      const userId = ctx.state.user.id;
      
      if (!orderId) {
        return ctx.badRequest('orderId is required');
      }
      
      // Test creating an order notification
      const notification = await strapi.service('api::notification.notification').createOrderNotification(
        orderId,
        userId, // publisherId
        userId, // advertiserId (same user for testing)
        action
      );
      
      console.log(`Test order notification created:`, notification.id);
      
      return {
        data: notification,
        meta: {
          message: 'Test order notification created successfully'
        }
      };
    } catch (error) {
      console.error('Error creating test order notification:', error);
      return ctx.internalServerError('An error occurred while creating test order notification');
    }
  },

  // Test all notification types
  async testAllNotifications(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;
      const testOrderId = 1; // Use a test order ID
      const testAmount = 100;
      
      const results = [];
      
      // Test all order notification types
      const orderActions = [
        'new_order',
        'order_accepted',
        'order_rejected',
        'order_delivered',
        'order_completed',
        'revision_requested',
        'revision_completed',
        'delivery_accepted_by_advertiser'
      ];
      
      for (const action of orderActions) {
        try {
          const notification = await strapi.service('api::notification.notification').createOrderNotification(
            testOrderId,
            userId, // publisherId
            userId, // advertiserId (same user for testing)
            action
          );
          results.push({ action, status: 'success', notificationId: notification.id });
        } catch (error) {
          results.push({ action, status: 'error', error: error.message });
        }
      }
      
      // Test payment notification types
      const paymentActions = ['payment_received', 'withdrawal_approved', 'withdrawal_denied', 'withdrawal_paid'];
      
      for (const action of paymentActions) {
        try {
          const notification = await strapi.service('api::notification.notification').createPaymentNotification(
            userId,
            action,
            testAmount,
            testOrderId
          );
          results.push({ action, status: 'success', notificationId: notification.id });
        } catch (error) {
          results.push({ action, status: 'error', error: error.message });
        }
      }
      
      // Test communication notification
      try {
        const notification = await strapi.service('api::notification.notification').createCommunicationNotification(
          userId,
          userId, // senderId (same user for testing)
          testOrderId,
          'message_received'
        );
        results.push({ action: 'message_received', status: 'success', notificationId: notification.id });
      } catch (error) {
        results.push({ action: 'message_received', status: 'error', error: error.message });
      }
      
      // Test system notification
      try {
        const notification = await strapi.service('api::notification.notification').createSystemNotification(
          userId,
          'Test System Notification',
          'This is a test system notification to verify the notification system is working.',
          'system_update'
        );
        results.push({ action: 'system_update', status: 'success', notificationId: notification.id });
      } catch (error) {
        results.push({ action: 'system_update', status: 'error', error: error.message });
      }
      
      console.log(`Test notifications created. Results:`, results);
      
      return {
        data: results,
        meta: {
          message: 'All notification types tested',
          totalTests: results.length,
          successful: results.filter(r => r.status === 'success').length,
          failed: results.filter(r => r.status === 'error').length
        }
      };
    } catch (error) {
      console.error('Error testing all notifications:', error);
      return ctx.internalServerError('An error occurred while testing notifications');
    }
  },

  // Test basic notification creation
  async testBasicNotification(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;
      console.log(`[NotificationController] Testing basic notification for user ${userId}`);
      
      // Test creating a simple notification directly
      const notification = await strapi.entityService.create('api::notification.notification', {
        data: {
          title: 'Test Notification',
          message: 'This is a test notification to verify the system is working.',
          type: 'system',
          action: 'system_update',
          recipient: userId,
          isRead: false
        }
      });
      
      console.log(`[NotificationController] Basic notification created: ${notification.id}`);
      
      return {
        data: notification,
        meta: {
          message: 'Basic notification created successfully'
        }
      };
    } catch (error) {
      console.error('Error creating basic notification:', error);
      return ctx.internalServerError('An error occurred while creating basic notification');
    }
  },

  // Test withdrawal notifications specifically
  async testWithdrawalNotifications(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;
      const testAmount = 100;
      
      const results = [];
      
      // Test all withdrawal notification types
      const withdrawalActions = ['withdrawal_approved', 'withdrawal_denied', 'withdrawal_paid'];
      
      for (const action of withdrawalActions) {
        try {
          console.log(`[NotificationController] Testing ${action} notification for user ${userId}`);
          
          const notification = await strapi.service('api::notification.notification').createPaymentNotification(
            userId,
            action,
            testAmount
          );
          
          results.push({ action, status: 'success', notificationId: notification.id });
          console.log(`[NotificationController] Successfully created ${action} notification: ${notification.id}`);
        } catch (error) {
          console.error(`[NotificationController] Failed to create ${action} notification:`, error);
          results.push({ action, status: 'error', error: error.message });
        }
      }
      
      console.log(`[NotificationController] Withdrawal notification test results:`, results);
      
      return {
        data: results,
        meta: {
          message: 'Withdrawal notification tests completed',
          totalTests: results.length,
          successful: results.filter(r => r.status === 'success').length,
          failed: results.filter(r => r.status === 'error').length
        }
      };
    } catch (error) {
      console.error('Error testing withdrawal notifications:', error);
      return ctx.internalServerError('An error occurred while testing withdrawal notifications');
    }
  }
}));

// Helper function to create notifications (can be used by other controllers)
const createNotification = async (strapi, data) => {
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
    
    console.log(`Notification created: ${notification.id} for user ${data.recipientId}`);
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
};

// Export the helper function for use in other controllers
module.exports.createNotification = createNotification; 