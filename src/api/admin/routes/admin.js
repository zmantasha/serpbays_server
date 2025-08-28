'use strict';

/**
 * Admin routes for admin panel
 */

'use strict';

/**
 * admin router
 */


module.exports = {
  routes: [
    // Admin Authentication
    {
      method: 'POST',
      path: '/api/admin/login',
      handler: 'admin.adminLogin',
      config: {
        auth: false, // No auth required for login
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'GET',
      path: '/api/admin/me',
      handler: 'admin.me',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    
    // Admin Dashboard
    {
      method: 'GET',
      path: '/api/admin/dashboard/stats',
      handler: 'admin.getDashboardStats',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    },
    {
      method: 'GET',
      path: '/api/admin/dashboard/activities',
      handler: 'admin.getRecentActivities',
      config: {
        policies: ['global::is-admin'],
        middlewares: ['global::admin-logger']
      }
    }
  ]
};
