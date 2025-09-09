'use strict';

/**
 * `is-super-admin` policy
 * Only allows super admins to access super admin functions
 */

module.exports = (policyContext, config, { strapi }) => {
  const { state } = policyContext;

  // Check if user is authenticated
  if (!state.user) {
    console.log('[SUPER ADMIN ACCESS DENIED] No authenticated user');
    return false;
  }

  // Check if user has super admin role
  const userRole = state.user.role;
  if (!userRole) {
    console.log(`[SUPER ADMIN ACCESS DENIED] User ${state.user.id} (${state.user.email}) has no role assigned`);
    return false;
  }

  // Only super admins can access super admin functions
  const isSuperAdmin = userRole.type === 'super_admin';

  // Log super admin access for security auditing
  if (isSuperAdmin) {
    console.log(`[SUPER ADMIN ACCESS] User ${state.user.id} (${state.user.email}) with role '${userRole.type}' accessed super admin function`);
  } else {
    console.log(`[SUPER ADMIN ACCESS DENIED] User ${state.user.id} (${state.user.email}) denied super admin access - Role: '${userRole.type}' (${userRole.name})`);
  }

  return isSuperAdmin;
};
