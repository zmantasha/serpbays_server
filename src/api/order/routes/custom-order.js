module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/orders',
      handler: 'order.create',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.create']
        }
      },
    },
    // Route to get orders for the current user
    {
      method: 'GET',
      path: '/orders/my-orders',
      handler: 'order.getMyOrders',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.find']
        }
      },
    },
    // Route to fix relations between orders and orderContent
    {
      method: 'POST',
      path: '/orders/fix-relations',
      handler: 'order.fixRelations',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.update']
        }
      },
    },
    // Route to migrate instructions from orders to outsourced content
    {
      method: 'POST',
      path: '/orders/migrate-instructions',
      handler: 'order.migrateInstructions',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.update']
        }
      },
    },
    // Route to fix links in order content
    {
      method: 'POST',
      path: '/orders/fix-links',
      handler: 'order.fixLinks',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.update']
        }
      },
    },
    // Route to get orders available for publishers to accept
    {
      method: 'GET',
      path: '/orders/available',
      handler: 'order.getAvailableOrders',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.find'],
        },
      },
    },
    // Route for publishers to accept an order
    {
      method: 'POST',
      path: '/orders/:id/accept',
      handler: 'order.acceptOrder',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.update'],
        },
      },
    },
    // Route for publishers to mark an order as delivered
    {
      method: 'POST',
      path: '/orders/:id/deliver',
      handler: 'order.deliverOrder',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.update'],
        },
      },
    },
    // Route for advertisers to complete an order
    {
      method: 'POST',
      path: '/orders/:id/complete',
      handler: 'order.completeOrder',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.update'],
        },
      },
    },
    // Route for advertisers to dispute an order
    {
      method: 'POST',
      path: '/orders/:id/dispute',
      handler: 'order.disputeOrder',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::order.order.update'],
        },
      },
    },
  ],
}; 