'use strict';

/**
 * Publisher dashboard "Needs your attention" (2026-09-25).
 * Default auth: the action is granted to the authenticated role at boot
 * (src/index.js), the same way marketplace.getUpdateHistory is.
 */
module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/publisher-websites/attention',
      handler: 'publisher-website.attention',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
