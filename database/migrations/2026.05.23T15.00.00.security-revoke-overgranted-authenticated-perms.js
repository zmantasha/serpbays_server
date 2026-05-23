'use strict';

/**
 * Migration: Revoke over-granted permissions from the 'authenticated' role
 * and add the matching grants to admin/super_admin where they were missing.
 *
 * Background (audit 2026-05-23):
 *   The 'authenticated' role in up_permissions had 165 grants. Many were
 *   admin-only operations granted to every logged-in user — trivially
 *   exploitable by registering any account, e.g.:
 *     - withdrawal-request.approveWithdrawal  (approve own withdrawal)
 *     - users-permissions.user.destroy / create / find / findOne / update
 *       (mass user listing, IDOR account takeover, etc.)
 *     - marketplace.marketplace.create / update / delete
 *     - transaction.razorpay-webhook.manualUpdate
 *     - role.createRole / deleteRole / updateRole  (privilege escalation)
 *     - and dozens more.
 *
 *   This migration revokes 66 actions from 'authenticated' (Phase 1 + 2 of
 *   the cleanup), grants 7 of them to 'admin' and 'super_admin' so the
 *   admin panel keeps working, and grants 'user.updateMe' to 'authenticated'
 *   so the custom PUT /api/users/me handler works for regular users (it was
 *   not granted in the original DB seed; the frontend was instead calling
 *   PUT /api/users/${user.id} which is an IDOR vector).
 *
 *   Idempotent: INSERTs use NOT EXISTS, DELETEs are no-ops when rows are
 *   already absent. Safe to re-run.
 *
 *   No frontend impact: serpbays_client was simultaneously refactored to
 *   call PUT /api/users/me everywhere (see commit d42cfc3).
 */

const REVOKE_FROM_AUTHENTICATED = [
  // ── Admin namespace
  'api::admin.admin.adminLogin',
  'api::admin.admin.getDashboardStats',

  // ── Chatroom admin / dev
  'api::chatroom.chatroom.adminChatView',
  'api::chatroom.chatroom.adminDashboard',
  'api::chatroom.chatroom.debugWebSocket',
  'api::chatroom.chatroom.delete',

  // ── Destructive deletes (admin-only)
  'api::communication.communication.delete',
  'api::invoice.invoice.delete',
  'api::project.project.delete',
  'api::saved-filter.saved-filter.delete',
  'api::shortlist.shortlist.delete',
  'api::transaction.transaction.delete',
  'api::website-request.website-request.delete',

  // ── Global config
  'api::global-config.global-config.delete',
  'api::global-config.global-config.update',
  'api::global.global.delete',
  'api::global.global.update',

  // ── Email operations (admin / webhooks)
  'api::global.email-operations.getEmailStats',
  'api::global.email-operations.handleIncomingEmail',
  'api::global.email-operations.processEmailCommand',
  'api::global.email-operations.testEmailOperation',
  'api::global.email-operations.triggerTransactionOperation',

  // ── Marketplace admin operations
  'api::marketplace.export-csv.adminList',
  'api::marketplace.export-csv.exportFiltered',
  'api::marketplace.export-csv.exportSelected',
  'api::marketplace.marketplace.bulkUpdateTAT',
  'api::marketplace.marketplace.checkDomainExists',
  'api::marketplace.marketplace.create',
  'api::marketplace.marketplace.delete',
  'api::marketplace.marketplace.update',
  'api::marketplace.marketplace.updateTAT',
  'api::marketplace.marketplace.uploadCSV',
  'api::order.order.migrateSnapshots',

  // ── Publisher-website moderation
  'api::publisher-website.admin-approval.manualApprove',
  'api::publisher-website.publisher-website.approve',
  'api::publisher-website.publisher-website.delete',
  'api::publisher-website.publisher-website.markUnderReview',
  'api::publisher-website.publisher-website.pauseListing',
  'api::publisher-website.publisher-website.reject',
  'api::publisher-website.publisher-website.resumeListing',

  // ── Reseller codes (admin)
  'api::reseller-code.reseller-code.create',
  'api::reseller-code.reseller-code.delete',
  'api::reseller-code.reseller-code.find',
  'api::reseller-code.reseller-code.findOne',
  'api::reseller-code.reseller-code.getCodeStats',
  'api::reseller-code.reseller-code.update',

  // ── Invoice / transaction admin
  'api::invoice.invoice.create',
  'api::invoice.invoice.update',
  'api::transaction.transaction.update',
  'api::transaction.razorpay-webhook.manualUpdate',

  // ── Wallet admin
  'api::user-wallet.user-wallet.fixCompletedOrderEarnings',
  'api::user-wallet.wallet.addPromoFunds',

  // ── Withdrawal admin
  'api::withdrawal-request.withdrawal-request.approveWithdrawal',
  'api::withdrawal-request.withdrawal-request.delete',

  // ── Users-permissions plugin (the biggest IDOR + mass-PII surface)
  'plugin::users-permissions.permissions.getPermissions',
  'plugin::users-permissions.role.createRole',
  'plugin::users-permissions.role.deleteRole',
  'plugin::users-permissions.role.find',
  'plugin::users-permissions.role.findOne',
  'plugin::users-permissions.role.updateRole',
  'plugin::users-permissions.user.count',
  'plugin::users-permissions.user.create',
  'plugin::users-permissions.user.destroy',
  'plugin::users-permissions.user.find',
  'plugin::users-permissions.user.findOne',
  'plugin::users-permissions.user.update',
];

// Actions where authenticated was the ONLY grant. Without adding admin/super_admin
// grants, panel20 (admin UI) and the Strapi admin panel would lose access.
const GRANT_TO_ADMIN_AND_SUPER_ADMIN = [
  'api::global.email-operations.getEmailStats',
  'api::global.email-operations.processEmailCommand',
  'api::global.email-operations.triggerTransactionOperation',
  'api::global.global.delete',
  'api::global.global.update',
  'api::invoice.invoice.delete',
  'api::transaction.razorpay-webhook.manualUpdate',
];

// The custom PUT /api/users/me handler (in extensions/users-permissions/
// strapi-server.js) uses action `user.updateMe`. Strapi's default DB seed
// does not grant this to anyone. Authenticated users need it to update
// their own profile via the IDOR-safe /me endpoint.
const GRANT_TO_AUTHENTICATED = ['plugin::users-permissions.user.updateMe'];

module.exports = {
  async up(knex) {
    console.log('[MIGRATION security-revoke-overgranted] Starting...');

    // 1. Add admin + super_admin grants where missing (so admin panel keeps working).
    const insertedAdminGrants = await knex.raw(
      `
      INSERT INTO up_permissions_role_lnk (permission_id, role_id)
      SELECT p.id, r.id
      FROM up_permissions p
      CROSS JOIN up_roles r
      WHERE p.action = ANY(?)
        AND r.type IN ('admin', 'super_admin')
        AND NOT EXISTS (
          SELECT 1 FROM up_permissions_role_lnk x
          WHERE x.permission_id = p.id AND x.role_id = r.id
        )
      `,
      [GRANT_TO_ADMIN_AND_SUPER_ADMIN]
    );
    console.log(
      `[MIGRATION security-revoke-overgranted] Inserted admin/super_admin grants: ${insertedAdminGrants.rowCount}`
    );

    // 2. Add user.updateMe grant to authenticated (was missing entirely).
    const insertedAuthGrants = await knex.raw(
      `
      INSERT INTO up_permissions_role_lnk (permission_id, role_id)
      SELECT p.id, r.id
      FROM up_permissions p
      CROSS JOIN up_roles r
      WHERE p.action = ANY(?)
        AND r.type = 'authenticated'
        AND NOT EXISTS (
          SELECT 1 FROM up_permissions_role_lnk x
          WHERE x.permission_id = p.id AND x.role_id = r.id
        )
      `,
      [GRANT_TO_AUTHENTICATED]
    );
    console.log(
      `[MIGRATION security-revoke-overgranted] Inserted authenticated grants: ${insertedAuthGrants.rowCount}`
    );

    // 3. Revoke 66 over-granted actions from 'authenticated'.
    const revoked = await knex.raw(
      `
      DELETE FROM up_permissions_role_lnk
      WHERE role_id = (SELECT id FROM up_roles WHERE type = 'authenticated')
        AND permission_id IN (
          SELECT id FROM up_permissions WHERE action = ANY(?)
        )
      `,
      [REVOKE_FROM_AUTHENTICATED]
    );
    console.log(
      `[MIGRATION security-revoke-overgranted] Revoked authenticated grants: ${revoked.rowCount}`
    );

    console.log('[MIGRATION security-revoke-overgranted] Done.');
  },
};
