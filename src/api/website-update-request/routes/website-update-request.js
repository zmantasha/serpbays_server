'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/website-update-requests/pending',
      handler: 'website-update-request.findPending',
      config: {
        policies: ['global::is-admin'],
      },
    },
    {
      method: 'POST',
      path: '/website-update-requests/:id/approve',
      handler: 'website-update-request.approve',
      config: {
        policies: ['global::is-admin'],
      },
    },
    {
      method: 'POST',
      path: '/website-update-requests/:id/reject',
      handler: 'website-update-request.reject',
      config: {
        policies: ['global::is-admin'],
      },
    },
  ],
};
