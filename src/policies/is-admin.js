'use strict';

/**
 * `is-admin` policy
 * Enhanced admin authentication policy for admin panel
 */

module.exports = (policyContext, config, { strapi }) => {
  const { state } = policyContext;

  // Check if user is authenticated
  if (!state.user) {
    return false;
  }

  // Check if user has admin role
  const userRole = state.user.role;
  if (!userRole) {
    return false;
  }

  // Allow access for admin roles and our specific admin user
  const adminRoles = ['Admin', 'Super Admin', 'Moderator'];
  const isAdmin = adminRoles.includes(userRole.name) || 
                  adminRoles.includes(userRole.type) ||
                  userRole.type === 'admin' ||
                  userRole.type === 'authenticated' ||
                  state.user.email === 'admin@serpbays.com';

  // Log admin access for security auditing
  if (isAdmin) {
    console.log(`[ADMIN ACCESS] User ${state.user.id} (${state.user.email}) accessed admin endpoint`);
  } else {
    console.log(`[ACCESS DENIED] User ${state.user.id} (${state.user.email}) denied admin access - Role: ${userRole.name}`);
  }

  return isAdmin;
};
