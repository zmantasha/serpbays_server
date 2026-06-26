'use strict';

/**
 * Routes for the Google Search Console verification flow.
 *
 *   POST /publisher-websites/:id/gsc-verify-init
 *     Auth: publisher JWT (users-permissions default pipeline)
 *     Purpose: bind a nonce to (user, row) server-side. Returns the nonce.
 *
 *   POST /publisher-websites/gsc-verify-callback
 *     Auth: false (HMAC over body is the gate)
 *     Purpose: server-to-server endpoint hit by the Next.js OAuth callback
 *              after Google has authenticated the user and we've fetched
 *              their GSC property list. Sets gscVerified=true on the bound
 *              row if a property covers it.
 */
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/publisher-websites/:id/gsc-verify-init',
      handler: 'publisher-website.gscVerifyInit',
      config: {
        // Standard users-permissions auth — only logged-in publishers can
        // initiate verification for their own rows.
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/publisher-websites/gsc-verify-callback',
      handler: 'publisher-website.gscVerifyCallback',
      config: {
        // HMAC is the gate; no Strapi auth.
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
