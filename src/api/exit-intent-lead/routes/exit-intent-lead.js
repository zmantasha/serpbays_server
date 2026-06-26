'use strict';

/**
 * exit-intent-lead router.
 *
 * Per-action overrides on the default core router. The POST /create
 * endpoint (used by the marketing-site popup) is the only externally-
 * reachable one and triggers an afterCreate notification email to the
 * sales inbox. Rate-limit added to defeat inbox-flood / lead-spam.
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::exit-intent-lead.exit-intent-lead', {
  config: {
    create: {
      // Public role has the `create` permission grant (intentional —
      // the popup needs an unauthenticated submission path). The
      // controller already enforces a strict field allow-list (Pass 11),
      // so caller-supplied mass-assignment is gated. This rate limit
      // blocks the email-flood vector: each create fires an outbound
      // notification email; 5/10min/IP keeps the sales inbox sane.
      policies: [{ name: 'global::simple-rate-limit', config: { max: 5, interval: 600000 } }],
    },
  },
});
