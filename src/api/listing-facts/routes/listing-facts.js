'use strict';

// Public read-only facts for one live listing (2026-10-15). Used server-side by
// the marketing site's /buy-backlinks/{niche}/{domain} pages so their title,
// hero and schema show the real price, DR and follow type instead of stale CMS text.
module.exports = {
  routes: [
    { method: 'GET', path: '/listing-facts', handler: 'listing-facts.find', config: { auth: false, policies: [{ name: 'global::simple-rate-limit', config: { interval: 60000, max: 600 } }] } },
  ],
};
