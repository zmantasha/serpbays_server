'use strict';

/**
 * `requires-view` policy
 *
 * Gates read endpoints on per-user pagePermissions.
 * Config: { pageKey: string } — the gateable page this route belongs to.
 *
 * Allow rules (any one is sufficient):
 *   - user is super_admin   (always allowed; pagePermissions ignored)
 *   - pagePermissions[pageKey].view === true
 *   - pagePermissions[pageKey].edit === true   (edit implies view)
 *
 * Deny rules:
 *   - no authenticated user
 *   - missing role
 *   - policy is misconfigured (no pageKey)
 *
 * Must be used in combination with `is-admin` (or another auth-gate policy)
 * to ensure state.user is populated.
 */

module.exports = async (policyContext, config, { strapi }) => {
  const { state } = policyContext;

  if (!state.user) return false;
  const userRole = state.user.role;
  if (!userRole) return false;

  if (userRole.type === 'super_admin') return true;

  const pageKey = config && config.pageKey;
  if (!pageKey) {
    strapi.log.warn('[requires-view] policy invoked without pageKey config');
    return false;
  }

  // state.user is populated by users-permissions auth middleware with all
  // scalar fields including the JSON pagePermissions column.
  const perms = state.user.pagePermissions || {};
  const entry = perms[pageKey];
  if (!entry) {
    strapi.log.info(
      `[ACCESS DENIED] view ${pageKey} - user ${state.user.id} (${state.user.email}) has no entry`,
    );
    return false;
  }

  const allowed = !!entry.view || !!entry.edit;
  if (!allowed) {
    strapi.log.info(
      `[ACCESS DENIED] view ${pageKey} - user ${state.user.id} (${state.user.email}) lacks view permission`,
    );
  }
  return allowed;
};
