'use strict';

/**
 * Admin action routes for publisher-website
 */

module.exports = {
  routes: [
    {
      method: 'PUT',
      path: '/publisher-websites/:id/approve',
      handler: 'publisher-website.approve',
      config: {
        description: 'Approve a publisher website submission',
      },
    },
    {
      method: 'PUT',
      path: '/publisher-websites/:id/reject',
      handler: 'publisher-website.reject',
      config: {
        description: 'Reject a publisher website submission',
      },
    },
    {
      method: 'PUT',
      path: '/publisher-websites/:id/request-changes',
      handler: 'publisher-website.requestChanges',
      config: {
        description: 'Request changes to a publisher website submission',
      },
    },
    {
      method: 'PUT',
      path: '/publisher-websites/:id/under-review',
      handler: 'publisher-website.markUnderReview',
      config: {
        description: 'Mark a submission as under review',
      },
    },
  ],
};
