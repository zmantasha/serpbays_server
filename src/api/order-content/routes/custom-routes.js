module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/orders/:orderId/content',
      handler: 'custom.getOrderContent',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
}; 