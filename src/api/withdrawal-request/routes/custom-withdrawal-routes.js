module.exports = {
  routes: [
    // Route for users to create withdrawal requests
    {
      method: 'POST',
      path: '/withdrawal-requests',
      handler: 'withdrawal-request.create',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::withdrawal-request.withdrawal-request.create']
        }
      },
    },
    // Route for users to view their own withdrawal requests
    {
      method: 'GET',
      path: '/withdrawal-requests/my',
      handler: 'withdrawal-request.getMyWithdrawals',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::withdrawal-request.withdrawal-request.find']
        }
      },
    },
    // Route for getting available publisher balance
    {
      method: 'GET',
      path: '/withdrawal-requests/available-balance',
      handler: 'withdrawal-request.getAvailableBalance',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::withdrawal-request.withdrawal-request.find']
        }
      },
    },
    // Route for admins to approve a withdrawal request
    {
      method: 'POST',
      path: '/admin/withdrawal-requests/:id/approve',
      handler: 'withdrawal-request.approveWithdrawal',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::withdrawal-request.withdrawal-request.update']
        }
      },
    },
    // Route for admins to deny a withdrawal request
    {
      method: 'POST',
      path: '/admin/withdrawal-requests/:id/deny',
      handler: 'withdrawal-request.denyWithdrawal',
      config: {
        middlewares: [],
        policies: [],
        auth: {
          scope: ['api::withdrawal-request.withdrawal-request.update']
        }
      },
    },
  ],
}; 