module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/api/cart',
      handler: 'cart.getUserCart',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/api/cart',
      handler: 'cart.updateCart',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'DELETE',
      path: '/api/cart',
      handler: 'cart.clearCart',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
}; 