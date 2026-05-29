'use strict';

/**
 * External partner API routes (versioned, read-only).
 *
 * Public-facing endpoints for selected API clients to search marketplace
 * sites and read advertiser-facing pricing. Auth is by per-client API key
 * (global::api-key-auth). `auth: false` skips Strapi's built-in
 * users-permissions permission check; the middleware populates
 * ctx.state.user instead.
 *
 * Rate limit is intentionally stricter than the in-app marketplace routes
 * to limit full-catalog scraping. NOTE: the limiter is in-memory and
 * per-IP (see policies/simple-rate-limit.js) — adequate for a handful of
 * partners; move to a per-key/Redis limiter if this opens up further.
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/external/v1/sites',
      handler: 'marketplace.externalFind',
      config: {
        auth: false,
        middlewares: ['global::api-key-auth'],
        policies: [
          {
            name: 'global::simple-rate-limit',
            config: { interval: 60000, max: 30 },
          },
        ],
      },
    },
    {
      method: 'GET',
      path: '/external/v1/sites/:id',
      handler: 'marketplace.externalFindOne',
      config: {
        auth: false,
        middlewares: ['global::api-key-auth'],
        policies: [
          {
            name: 'global::simple-rate-limit',
            config: { interval: 60000, max: 30 },
          },
        ],
      },
    },
  ],
};
