'use strict';

/**
 * No routes registered. Bulk-refresh-job rows are only accessed
 * through /admin/marketplace/bulk-refresh/* endpoints, gated by
 * is-admin. Exposing core REST here would let any authenticated
 * caller list or mutate job rows.
 */

module.exports = { routes: [] };
