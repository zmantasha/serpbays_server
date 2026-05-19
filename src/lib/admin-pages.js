'use strict';

/**
 * Single source of truth for gateable admin pages.
 *
 * Each key maps to a top-level route segment in serpbays_admin.
 * The page registry on the frontend (serpbays_admin/src/lib/admin-pages.ts)
 * must mirror this list — keep them in sync.
 *
 * Per-page capability flags control which permission columns are meaningful:
 *   - hasCreate: page has at least one create-style action (originating
 *                new records). The permission grid shows a Create checkbox
 *                for these and the route's create handler is gated by
 *                requires-create.
 *   - hasDelete: page has at least one delete-style action. Shows a Delete
 *                checkbox and gates with requires-delete.
 *
 * Pages excluded from this registry:
 *   - "dashboard"        always granted to any admin (landing page)
 *   - "role-management"  super_admin only, not assignable
 *   - "access-denied"    public error page
 */

const ADMIN_PAGES = [
  { key: 'users',            label: 'Users',            hasCreate: false, hasDelete: true  },
  { key: 'orders',           label: 'Orders',           hasCreate: true,  hasDelete: false },
  { key: 'websites',         label: 'Websites',         hasCreate: false, hasDelete: true  },
  { key: 'marketplace',      label: 'Marketplace',      hasCreate: true,  hasDelete: true  },
  { key: 'website-requests', label: 'Website Requests', hasCreate: false, hasDelete: false },
  { key: 'shared-lists',     label: 'Shared Lists',     hasCreate: false, hasDelete: true  },
  { key: 'communications',   label: 'Communications',   hasCreate: false, hasDelete: true  },
  { key: 'transactions',     label: 'Transactions',     hasCreate: false, hasDelete: false },
  { key: 'wallets',          label: 'Wallets',          hasCreate: false, hasDelete: false },
  { key: 'withdrawals',      label: 'Withdrawals',      hasCreate: false, hasDelete: false },
  { key: 'codes',            label: 'Codes',            hasCreate: true,  hasDelete: true  },
  { key: 'offers',           label: 'Offers',           hasCreate: true,  hasDelete: true  },
  { key: 'analytics',        label: 'Analytics',        hasCreate: false, hasDelete: false },
  { key: 'settings',         label: 'Settings',         hasCreate: false, hasDelete: false },
  { key: 'audit-logs',       label: 'Audit Logs',       hasCreate: false, hasDelete: false },
];

const ADMIN_PAGE_KEYS = ADMIN_PAGES.map((p) => p.key);
const PAGES_WITH_CREATE = new Set(
  ADMIN_PAGES.filter((p) => p.hasCreate).map((p) => p.key),
);
const PAGES_WITH_DELETE = new Set(
  ADMIN_PAGES.filter((p) => p.hasDelete).map((p) => p.key),
);

function emptyPermissions() {
  const out = {};
  for (const key of ADMIN_PAGE_KEYS) {
    out[key] = { view: false, edit: false, create: false, delete: false };
  }
  return out;
}

function allPermissions() {
  const out = {};
  for (const key of ADMIN_PAGE_KEYS) {
    out[key] = {
      view: true,
      edit: true,
      // create/delete synth true only on pages that actually expose them,
      // so super_admin's resolved map mirrors what the backend can grant.
      create: PAGES_WITH_CREATE.has(key),
      delete: PAGES_WITH_DELETE.has(key),
    };
  }
  return out;
}

/**
 * Normalize an arbitrary stored value into a complete permission map.
 * Unknown keys are dropped; missing keys default to false. Pages without
 * the corresponding capability coerce that flag to false so stale stored
 * values can't grant a permission the backend doesn't enforce anywhere.
 */
function normalizePermissions(stored) {
  const base = emptyPermissions();
  if (!stored || typeof stored !== 'object') return base;
  for (const key of ADMIN_PAGE_KEYS) {
    const entry = stored[key];
    if (entry && typeof entry === 'object') {
      base[key] = {
        view: Boolean(entry.view),
        edit: Boolean(entry.edit),
        create: PAGES_WITH_CREATE.has(key) && Boolean(entry.create),
        delete: PAGES_WITH_DELETE.has(key) && Boolean(entry.delete),
      };
    }
  }
  return base;
}

/**
 * Resolve the runtime permission map for a user.
 * super_admin always gets full access regardless of stored value.
 */
function resolvePermissions(user) {
  const roleType = user?.role?.type;
  if (roleType === 'super_admin') return allPermissions();
  return normalizePermissions(user?.pagePermissions);
}

module.exports = {
  ADMIN_PAGES,
  ADMIN_PAGE_KEYS,
  PAGES_WITH_CREATE,
  PAGES_WITH_DELETE,
  emptyPermissions,
  allPermissions,
  normalizePermissions,
  resolvePermissions,
};
