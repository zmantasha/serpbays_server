'use strict';

/**
 * api-log custom router
 *
 * NOTE: We deliberately do NOT use `createCoreRouter` here because it would
 * expose POST / PUT / DELETE endpoints. API logs are written by the Winston
 * DB transport via `strapi.db.query` and are immutable from the HTTP layer.
 * Only super admins can read them.
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/api-logs',
      handler: 'api-log.find',
      config: {
        policies: ['global::is-super-admin'],
      },
    },
    {
      method: 'GET',
      path: '/api-logs/:id',
      handler: 'api-log.findOne',
      config: {
        policies: ['global::is-super-admin'],
      },
    },
  ],
};
