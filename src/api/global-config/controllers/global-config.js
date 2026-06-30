'use strict';

/**
 * global-config controller
 *
 * The default route `GET /api/global-config` is granted to the
 * `authenticated` role. Without overrides, the default core-controller's
 * `find` returns EVERY field on the singleType — including internal
 * business config that shouldn't be visible to regular users:
 *
 *   - autoApproveDays:   how many days before a delivered order is auto-
 *                        approved. Knowing this lets a hostile publisher
 *                        time deliveries to exploit auto-approval edge
 *                        cases. ADMIN-ONLY.
 *   - autoReleaseDays:   how many days before escrow auto-releases.
 *                        Same exploit surface. ADMIN-ONLY.
 *   - paymentGateways:   the full {gateway: {enabled, displayName, ...}}
 *                        map — including disabled gateways. Knowing which
 *                        gateways are DISABLED is a privacy/competitive
 *                        signal (e.g. "they turned off PhonePe" tells a
 *                        scraper they're abandoning that market).
 *                        Filter to enabled-only for non-admins.
 *
 * Public-safe fields (returned to all authenticated users):
 *   - minPayoutAmount     — users need to see the minimum withdrawal cap
 *   - supportedCurrencies — UI needs to render currency selectors
 *   - paymentGateways     — but with `enabled: false` entries STRIPPED,
 *                           and the `description` field dropped (often
 *                           contains internal notes)
 *   - newsletterEnabled   — UI shows/hides the newsletter signup
 */

const { createCoreController } = require('@strapi/strapi').factories;

// Fields safe to return to ANY authenticated user. Admins see the full
// row (including the admin-only fields below) via this same endpoint.
const PUBLIC_FIELDS = [
  'minPayoutAmount',
  'supportedCurrencies',
  'paymentGateways',     // shaped further below (enabled-only)
  'newsletterEnabled',
];

// Fields that must NEVER appear in a non-admin response.
const ADMIN_ONLY_FIELDS = [
  'autoApproveDays',
  'autoReleaseDays',
];

const isAdminUser = (user) => {
  if (!user || !user.role) return false;
  const t = user.role.type;
  return t === 'admin' || t === 'super_admin';
};

// Shape paymentGateways for non-admin consumption:
//   - drop entries where `enabled === false` (don't leak disabled gateways)
//   - drop internal description text (may contain ops notes)
//   - return only `{ displayName }` per remaining gateway
const shapePaymentGatewaysPublic = (raw) => {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [name, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.enabled === false) continue;
    out[name] = { displayName: cfg.displayName || name };
  }
  return out;
};

module.exports = createCoreController('api::global-config.global-config', ({ strapi }) => ({
  /**
   * GET /api/global-config — returns a public allow-list for non-admins,
   * full row for admins.
   */
  async find(ctx) {
    // Pull the singleton from the DB — the default core controller does
    // this via super.find, but the response shape differs between Strapi
    // 4 and 5 (Strapi 5 drops the `attributes` wrapper). Read directly
    // so we have a stable, easy-to-allow-list shape.
    const row = await strapi.db.query('api::global-config.global-config').findOne({
      where: {}, // singleType
    });
    if (!row) {
      return { data: null };
    }

    const user = ctx.state?.user;
    if (isAdminUser(user)) {
      // Admins get the full row (including autoApproveDays / autoReleaseDays
      // and the raw paymentGateways map with all flags).
      return { data: row };
    }

    // Non-admin: build a stripped response.
    const safe = {};
    for (const key of PUBLIC_FIELDS) {
      if (key === 'paymentGateways') {
        safe.paymentGateways = shapePaymentGatewaysPublic(row.paymentGateways);
      } else if (key in row) {
        safe[key] = row[key];
      }
    }
    // Belt-and-braces: never let an admin-only field slip into a non-admin
    // response, even if PUBLIC_FIELDS is widened in a future edit.
    for (const k of ADMIN_ONLY_FIELDS) {
      delete safe[k];
    }
    return { data: safe };
  },

  /**
   * Strapi 5 also routes `findOne` for singleType endpoints internally —
   * surface the same allow-list there.
   */
  async findOne(ctx) {
    return this.find(ctx);
  },
}));
