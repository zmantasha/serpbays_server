'use strict';

/**
 * `requires-delete` policy
 *
 * Gates destructive endpoints (DELETE methods and bulk*Delete handlers) on
 * per-user pagePermissions.
 * Config: { pageKey: string } — the gateable page this route belongs to.
 *
 * Allow rules:
 *   - user is super_admin   (always allowed; pagePermissions ignored)
 *   - pagePermissions[pageKey].delete === true
 *
 * Edit and view do NOT imply delete — delete is held separately on purpose
 * so super admin can grant approve/reject/transfer (edit) without granting
 * destructive deletion to the same admin.
 *
 * Must be paired with `is-admin` (or another auth-gate policy) to ensure
 * state.user is populated.
 */

module.exports = async (policyContext, config, { strapi }) => {
  const { state } = policyContext;

  if (!state.user) return false;
  const userRole = state.user.role;
  if (!userRole) return false;

  if (userRole.type === 'super_admin') return true;

  const pageKey = config && config.pageKey;
  if (!pageKey) {
    strapi.log.warn('[requires-delete] policy invoked without pageKey config');
    return false;
  }

  const perms = state.user.pagePermissions || {};
  const entry = perms[pageKey];
  const allowed = !!entry && !!entry.delete;
  if (!allowed) {
    strapi.log.info(
      `[ACCESS DENIED] delete ${pageKey} - user ${state.user.id} (${state.user.email}) lacks delete permission`,
    );
  }
  return allowed;
};
