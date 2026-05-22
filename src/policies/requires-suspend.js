'use strict';

/**
 * `requires-suspend` policy
 *
 * Gates account-state-toggle endpoints (suspend / activate / block / unblock)
 * on per-user pagePermissions.
 * Config: { pageKey: string } — the gateable page this route belongs to.
 *
 * Allow rules:
 *   - user is super_admin   (always allowed; pagePermissions ignored)
 *   - pagePermissions[pageKey].suspend === true
 *
 * Held separately from edit on purpose — suspending a user locks them out
 * of their account and is materially more consequential than editing
 * profile fields. Super admin can grant "edit user details" (edit) without
 * also handing out "lock the account" (suspend).
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
    strapi.log.warn('[requires-suspend] policy invoked without pageKey config');
    return false;
  }

  const perms = state.user.pagePermissions || {};
  const entry = perms[pageKey];
  const allowed = !!entry && !!entry.suspend;
  if (!allowed) {
    strapi.log.info(
      `[ACCESS DENIED] suspend ${pageKey} - user ${state.user.id} (${state.user.email}) lacks suspend permission`,
    );
  }
  return allowed;
};
