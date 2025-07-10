'use strict';

module.exports = {
  async afterCreate(event) {
    const { result } = event;
    
    try {
      console.log(`[NotificationLifecycle] afterCreate triggered for notification ${result.id}`);
      
      // Get the full notification data with recipient
      const notification = await strapi.entityService.findOne('api::notification.notification', result.id, {
        populate: ['recipient']
      });
      
      if (!notification?.recipient?.id) {
        console.log(`[NotificationLifecycle] No recipient found for notification ${result.id}`);
        return;
      }

      if (!strapi.io || !strapi.io.emitToUser) {
        console.log(`[NotificationLifecycle] WebSocket not available`);
        return;
      }

      const userId = notification.recipient.id;
      
      // Get updated unread count for the user
      const unreadCount = await strapi.db.query('api::notification.notification').count({
        where: {
          recipient: userId,
          isRead: false
        }
      });

      const userChannel = `user_${userId}_notification`;
      
      console.log(`📤 Emitting new notification to ${userChannel} for user ${userId}`);
      
      // Emit the new notification
      const success = strapi.io.emitToUser(userId, userChannel, {
        type: 'notification',
        data: {
          id: notification.id,
          title: notification.title,
          message: notification.message,
          type: notification.type,
          action: notification.action,
          isRead: notification.isRead,
          relatedOrderId: notification.relatedOrderId,
          relatedUserId: notification.relatedUserId,
          createdAt: notification.createdAt,
          updatedAt: notification.updatedAt
        }
      });
      
      // Also emit the updated unread count
      const countSuccess = strapi.io.emitToUser(userId, userChannel, {
        type: 'notification_count',
        data: { unreadCount }
      });
      
      if (success) {
        console.log(`✅ Successfully emitted notification ${notification.id} to user ${userId}`);
      } else {
        console.log(`⚠️ User ${userId} not connected to WebSocket`);
      }
      
      if (countSuccess) {
        console.log(`✅ Successfully emitted unread count ${unreadCount} to user ${userId}`);
      } else {
        console.log(`⚠️ Failed to emit unread count to user ${userId}`);
      }
      
    } catch (error) {
      console.error(`[NotificationLifecycle] Error in afterCreate hook:`, error);
    }
  }
}; 