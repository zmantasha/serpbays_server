'use strict';

/**
 * notification router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

// Create the default router
const defaultRouter = createCoreRouter('api::notification.notification');

// Custom routes
const customRoutes = {
  routes: [
    {
      method: 'GET',
      path: '/notifications/my',
      handler: 'notification.getMyNotifications',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/notifications/:id/read',
      handler: 'notification.markAsRead',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/notifications/mark-all-read',
      handler: 'notification.markAllAsRead',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'DELETE',
      path: '/notifications/:id',
      handler: 'notification.deleteNotification',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/notifications/test-basic',
      handler: 'notification.testBasicNotification',
      config: {
        policies: [],
        middlewares: [],
      },
    }
  ],
};

module.exports = customRoutes; 