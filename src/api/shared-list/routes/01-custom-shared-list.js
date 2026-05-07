'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/shared-lists/:slug',
      handler: 'shared-list.findBySlug',
      config: {
        // Public route — auth is optional. The controller enforces private-mode
        // gating itself. Strapi's default users-permissions auth still runs
        // when the caller passes a Bearer token, populating ctx.state.user.
        auth: false,
        // Throttle by IP to protect against slug enumeration / view-count spam.
        // 60 reads per minute per IP is plenty for a real customer browsing.
        policies: [
          { name: 'global::simple-rate-limit', config: { max: 60, interval: 60000 } },
        ],
      },
    },
  ],
};
