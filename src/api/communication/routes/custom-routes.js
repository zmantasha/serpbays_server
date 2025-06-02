module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/communications/order/:orderId',
      handler: 'communication.getOrderCommunications',
      config: {
        auth: {
          scope: ['api::communication.communication.getOrderCommunications']
        },
      },
    },
    {
      method: 'PUT',
      path: '/communications/:id/status',
      handler: 'communication.updateStatus',
      config: {
        auth: {
          scope: ['api::communication.communication.updateStatus']
        },
      },
    },
  ],
}; 