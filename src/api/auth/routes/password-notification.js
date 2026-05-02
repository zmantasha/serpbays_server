'use strict';

/**
 * Password changed notification route
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/auth/password-changed-notification',
      handler: 'password-notification.sendNotification',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
