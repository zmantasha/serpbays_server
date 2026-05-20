'use strict';

/**
 * `requires-create` policy
 *
 * Gates create-style endpoints (orders.createOnBehalf, marketplace
 * .bulkImport, etc.) on per-user pagePermissions.
 * Config: { pageKey: string } — the gateable page this route belongs to.
 *
 * Allow rules:
 *   - user is super_admin   (always allowed; pagePermissions ignored)
 *   - pagePermissions[pageKey].create === true
 *
 * Edit does NOT imply create — separating them is the whole point of this
 * policy. An admin can be allowed to update existing records without being
 * allowed to originate new ones.
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
    strapi.log.warn('[requires-create] policy invoked without pageKey config');
    return false;
  }

  const perms = state.user.pagePermissions || {};
  const entry = perms[pageKey];
  const allowed = !!entry && !!entry.create;
  if (!allowed) {
    strapi.log.info(
      `[ACCESS DENIED] create ${pageKey} - user ${state.user.id} (${state.user.email}) lacks create permission`,
    );
  }
  return allowed;
};
