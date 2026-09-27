'use strict';

/**
 * Publisher-side reseller application (2026-09-27). Custom routes only — the
 * core CRUD router is intentionally NOT registered, so applications are never
 * listable/editable from the public API. Both actions are granted to the
 * authenticated role at boot (src/index.js), like publisher-website.attention.
 */
module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/reseller-applications',
      handler: 'reseller-application.submit',
      config: { policies: [{ name: 'global::simple-rate-limit', config: { interval: 60000, max: 5 } }], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/reseller-applications/me',
      handler: 'reseller-application.me',
      config: { policies: [], middlewares: [] },
    },
  ],
};
