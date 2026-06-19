'use strict';

/**
 * Audit C5 — Remove the `up_permissions` rows for the deleted
 * `api::user-wallet.user-wallet.fixCompletedOrderEarnings` action.
 *
 * Pre-migration state (production DB query 2026-06-17):
 *   perm_id 1826 → role 1  (authenticated)  ← EXPLOITABLE
 *   perm_id 1778 → role 4  (super_admin)
 *   perm_id  169 → orphan  (no role link)
 *
 * The earlier 2026.05.23 over-granted-perms migration listed this action
 * for revocation, but the DB query above shows the authenticated grant is
 * present again. Whether the May migration didn't run here or a re-seed
 * relinked it, relying on revocation alone is fragile. With the route +
 * handler now deleted in code, Strapi's `routesPermissions` boot scan no
 * longer enumerates this action, so deleting the rows here makes the
 * removal sticky — there is no route the loader can map back to it.
 *
 * Behavior: idempotent. The DELETE removes the permission row by
 * `action` (which cascades the link rows via FK ON DELETE CASCADE on
 * `up_permissions_role_lnk.permission_id`). Safe to re-run.
 */

const REMOVED_ACTION = 'api::user-wallet.user-wallet.fixCompletedOrderEarnings';

module.exports = {
  async up(knex) {
    const before = await knex('up_permissions')
      .where({ action: REMOVED_ACTION })
      .select('id');
    if (before.length === 0) {
      console.log('[MIGRATION security-remove-fix-earnings] No rows to remove (already clean).');
      return;
    }
    const ids = before.map((r) => r.id);
    console.log(
      `[MIGRATION security-remove-fix-earnings] Removing up_permissions rows: ${ids.join(', ')}`
    );

    // Belt-and-suspenders: explicitly delete link rows in case the FK
    // is not ON DELETE CASCADE in this environment.
    const linkDeleted = await knex('up_permissions_role_lnk')
      .whereIn('permission_id', ids)
      .delete();
    const permDeleted = await knex('up_permissions')
      .where({ action: REMOVED_ACTION })
      .delete();
    console.log(
      `[MIGRATION security-remove-fix-earnings] Deleted ${linkDeleted} link rows, ${permDeleted} permission rows.`
    );
  },
};
