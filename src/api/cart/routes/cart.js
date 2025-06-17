'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/api/cart',
      handler: 'cart.getUserCart',
      config: {
        policies: [],
        middlewares: []
      }
    },
    {
      method: 'PUT',
      path: '/api/cart',
      handler: 'cart.updateUserCart',
      config: {
        policies: [],
        middlewares: []
      }
    }
  ]
}; 