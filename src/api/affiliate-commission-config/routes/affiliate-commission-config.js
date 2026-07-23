'use strict';

/**
 * The singleType's built-in `/api/affiliate-commission-config` routes are
 * intentionally not exposed here. Config read + update lives under the
 * admin router (see src/api/admin/routes/affiliate-commission-config.js)
 * and is gated by `global::is-admin` + `global::admin-jwt-auth`.
 *
 * Exporting an empty `routes` array is the Strapi-supported way to keep a
 * content-type without a public REST surface.
 */

module.exports = { routes: [] };
