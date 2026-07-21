'use strict';

/**
 * affiliate-link-click router
 *
 * Public tracking endpoint. Auth is intentionally OFF — the click happens
 * before signup. All other endpoints on this content type are gated below.
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/affiliate-tracking/click',
      handler: 'affiliate-link-click.recordClick',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
