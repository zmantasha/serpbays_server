'use strict';

// Meeting requests from signed-in users (2026-10-02). Controller-only API:
// nothing is stored, the message is emailed straight to the inbox that books
// the meetings. Rate limited per IP so a stuck client cannot spam that inbox.
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/meeting-requests',
      handler: 'meeting-request.submit',
      config: {
        policies: [{ name: 'global::simple-rate-limit', config: { interval: 3600000, max: 5 } }],
        middlewares: [],
      },
    },
  ],
};
