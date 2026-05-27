'use strict';

/**
 * `is-admin` policy
 * Enhanced admin authentication policy for admin panel
 * Only allows users with proper admin roles to access admin endpoints
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
    strapi.log.warn(`[ACCESS DENIED] User ${state.user.id} (${state.user.email}) has no role assigned`);
    return false;
  }

  // Define allowed admin role types (strict checking)
  const allowedAdminTypes = ['super_admin', 'admin'];
  const isAdmin = allowedAdminTypes.includes(userRole.type);

  // Log admin access for security auditing
  if (isAdmin) {
    strapi.log.warn(`[ADMIN ACCESS] User ${state.user.id} (${state.user.email}) with role '${userRole.type}' accessed admin endpoint`);
  } else {
    strapi.log.warn(`[ACCESS DENIED] User ${state.user.id} (${state.user.email}) denied admin access - Role: '${userRole.type}' (${userRole.name})`);
  }

  return isAdmin;
};
