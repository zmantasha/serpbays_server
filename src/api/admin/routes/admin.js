module.exports = {
  routes: [
    // Admin Authentication Routes
    {
      method: 'POST',
      path: '/admin/signup',
      handler: 'admin.signup',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/admin/login',
      handler: 'admin.login',
      config: {
        auth: false,
      },
    },
    // Existing Routes
    {
      method: 'GET',
      path: '/admin/dashboard-stats',
      handler: 'admin.getDashboardStats',
      config: {
        policies: ['global::is-admin'],
      },
    },
    {
      method: 'GET',
      path: '/admin/users',
      handler: 'admin.getUsers',
      config: {
        policies: ['global::is-admin'],
      },
    },
    {
      method: 'PUT',
      path: '/admin/users/:id',
      handler: 'admin.updateUser',
      config: {
        policies: ['global::is-admin'],
      },
    },
    {
      method: 'DELETE',
      path: '/admin/users/:id',
      handler: 'admin.deleteUser',
      config: {
        policies: ['global::is-admin'],
      },
    },
    {
      method: 'GET',
      path: '/admin/content',
      handler: 'admin.getContent',
      config: {
        policies: ['global::is-admin'],
      },
    },
    {
      method: 'PUT',
      path: '/admin/content/:id',
      handler: 'admin.updateContent',
      config: {
        policies: ['global::is-admin'],
      },
    },
    {
      method: 'DELETE',
      path: '/admin/content/:id',
      handler: 'admin.deleteContent',
      config: {
        policies: ['global::is-admin'],
      },
    },
  ],
}; 