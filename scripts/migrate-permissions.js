#!/usr/bin/env node

'use strict';

/**
 * One-shot migration:
 *   1. Compute initial pagePermissions for every admin user from the old
 *      hardcoded ROLE_PERMISSIONS map (frontend's permissions.ts).
 *   2. Reassign all 'moderator' users to the 'admin' role (moderator role
 *      type is being retired in Phase 5; their derived pagePermissions
 *      preserve the read-only access they had before).
 *   3. Persist on the user record. super_admin users are skipped — they
 *      get all-access synthesized at runtime.
 *
 * Idempotent: re-running only overwrites users that have no pagePermissions
 * stored yet. Pass --force to recompute for all admin users.
 *
 * Usage: node scripts/migrate-permissions.js [--force]
 */

const path = require('path');

const ADMIN_DEFAULTS = {
  users:            { view: true, edit: true },
  orders:           { view: true, edit: true },
  websites:         { view: true, edit: true },
  marketplace:      { view: true, edit: true },
  'website-requests': { view: true, edit: true },
  'shared-lists':   { view: true, edit: true },
  communications:   { view: true, edit: true },
  transactions:     { view: true, edit: true },
  wallets:          { view: true, edit: true },
  withdrawals:      { view: true, edit: true },
  codes:            { view: true, edit: true },
  offers:           { view: true, edit: true },
  analytics:        { view: true, edit: true },
  settings:         { view: false, edit: false },
  'audit-logs':     { view: false, edit: false },
};

const MODERATOR_DEFAULTS = {
  users:            { view: true, edit: false },
  orders:           { view: true, edit: false },
  websites:         { view: true, edit: false },
  marketplace:      { view: true, edit: false },
  'website-requests': { view: true, edit: false },
  'shared-lists':   { view: true, edit: false },
  communications:   { view: true, edit: true },
  transactions:     { view: false, edit: false },
  wallets:          { view: false, edit: false },
  withdrawals:      { view: false, edit: false },
  codes:            { view: false, edit: false },
  offers:           { view: false, edit: false },
  analytics:        { view: false, edit: false },
  settings:         { view: false, edit: false },
  'audit-logs':     { view: false, edit: false },
};

async function main() {
  const force = process.argv.includes('--force');

  const { default: strapi } = await import('@strapi/strapi');
  const app = strapi({
    dir: path.resolve(__dirname, '..'),
    autoReload: false,
    serveAdminPanel: false,
  });
  await app.load();

  console.log(`[MIGRATE] Started (force=${force})`);

  let adminRole = await app.db.query('plugin::users-permissions.role').findOne({
    where: { type: 'admin' },
  });
  if (!adminRole) {
    adminRole = await app.db.query('plugin::users-permissions.role').create({
      data: {
        name: 'Admin',
        description: 'Administrative access (permissions assigned per user)',
        type: 'admin',
      },
    });
    console.log(`[MIGRATE] Created missing 'admin' role (id=${adminRole.id})`);
  }

  const users = await app.db.query('plugin::users-permissions.user').findMany({
    populate: ['role'],
  });

  let updated = 0;
  let skipped = 0;
  let reassigned = 0;

  for (const user of users) {
    const roleType = user.role?.type;
    if (!['admin', 'moderator', 'super_admin'].includes(roleType)) {
      continue;
    }

    if (roleType === 'super_admin') {
      // Super admin gets all-access at runtime; nothing to store.
      skipped++;
      continue;
    }

    const hasExisting =
      user.pagePermissions &&
      typeof user.pagePermissions === 'object' &&
      Object.keys(user.pagePermissions).length > 0;

    if (hasExisting && !force) {
      skipped++;
      continue;
    }

    const data = {
      pagePermissions:
        roleType === 'moderator' ? MODERATOR_DEFAULTS : ADMIN_DEFAULTS,
    };

    if (roleType === 'moderator') {
      data.role = adminRole.id;
      reassigned++;
    }

    await app.db.query('plugin::users-permissions.user').update({
      where: { id: user.id },
      data,
    });

    updated++;
    console.log(
      `[MIGRATE] user=${user.id} email=${user.email} role=${roleType} -> permissions seeded${
        roleType === 'moderator' ? ' + reassigned to admin' : ''
      }`,
    );
  }

  console.log(`[MIGRATE] Done. updated=${updated} skipped=${skipped} moderator->admin=${reassigned}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[MIGRATE] FAILED', err);
    process.exit(1);
  });
}
