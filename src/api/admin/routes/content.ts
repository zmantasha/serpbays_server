export default {
  routes: [
    {
      method: 'GET',
      path: '/admin/content',
      handler: 'content.find',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'GET',
      path: '/admin/content/:id',
      handler: 'content.findOne',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'POST',
      path: '/admin/content',
      handler: 'content.create',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'PUT',
      path: '/admin/content/:id',
      handler: 'content.update',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    {
      method: 'DELETE',
      path: '/admin/content/:id',
      handler: 'content.delete',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
  ],
}; 