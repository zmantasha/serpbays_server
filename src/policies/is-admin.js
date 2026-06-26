'use strict';

/**
 * `is-admin` policy
 * Enhanced admin authentication policy for admin panel
 * Only allows users with proper admin roles to access admin endpoints
 *
 * Logging policy (post-bug-fix 2026-06-25):
 *   - HAPPY PATH (admin allowed): no log line. The strapi::logger middleware
 *     already records method/path/status/duration for every request, which
 *     is sufficient audit. Logging again here at WARN level on EVERY admin
 *     endpoint hit (a) flooded the log with noise on idle /api/admin/me
 *     polls and (b) exposed the admin email address in plaintext on every
 *     row — PII leakage observed in prod logs.
 *   - DENY PATH (auth missing or role wrong): WARN with userId + role, NO
 *     email. userId is enough to pivot back to the user via the DB if a
 *     security review needs to investigate; the email itself is PII and
 *     doesn't belong in routine logs.
 */

module.exports = (policyContext, config, { strapi }) => {
  const { state } = policyContext;

  // Check if user is authenticated
  if (!state.user) {
    strapi.log.warn('[ACCESS DENIED] No authenticated user');
    return false;
  }

  // Check if user has admin role
  const userRole = state.user.role;
  if (!userRole) {
    strapi.log.warn(`[ACCESS DENIED] User #${state.user.id} has no role assigned`);
    return false;
  }

  // Define allowed admin role types (strict checking)
  const allowedAdminTypes = ['super_admin', 'admin'];
  const isAdmin = allowedAdminTypes.includes(userRole.type);

  if (!isAdmin) {
    // Real security event — log without PII (email).
    strapi.log.warn(`[ACCESS DENIED] User #${state.user.id} denied admin access — role='${userRole.type}'`);
  }

  // Happy path is silent — strapi::logger middleware already records the
  // request line. Keeping a per-request log here was the source of the
  // observed email-in-logs exposure.
  return isAdmin;
};
