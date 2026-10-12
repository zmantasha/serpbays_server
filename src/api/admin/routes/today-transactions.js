'use strict';

// Dashboard "Today's transactions" block. Read-only; needs Transactions view (super admins always).
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/dashboard/today-transactions',
      handler: 'today-transactions.today',
      config: { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] },
    },
  ],
};
