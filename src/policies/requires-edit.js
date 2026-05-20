'use strict';

/**
 * `requires-edit` policy
 *
 * Gates mutating endpoints (POST/PUT/DELETE typically) on per-user
 * pagePermissions.
 * Config: { pageKey: string } — the gateable page this route belongs to.
 *
 * Allow rules:
 *   - user is super_admin   (always allowed; pagePermissions ignored)
 *   - pagePermissions[pageKey].edit === true
 *   - pagePermissions[pageKey].delete === true   (delete implies edit)
 *
 * Note: edit does NOT degrade to view here — a route guarded by requires-edit
 * is a mutation and must require at least the edit flag.
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
    strapi.log.warn('[requires-edit] policy invoked without pageKey config');
    return false;
  }

  const perms = state.user.pagePermissions || {};
  const entry = perms[pageKey];
  const allowed = !!entry && (!!entry.edit || !!entry.delete);
  if (!allowed) {
    strapi.log.info(
      `[ACCESS DENIED] edit ${pageKey} - user ${state.user.id} (${state.user.email}) lacks edit permission`,
    );
  }
  return allowed;
};
