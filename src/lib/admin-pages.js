'use strict';

/**
 * Single source of truth for gateable admin pages.
 *
 * Each key maps to a top-level route segment in serpbays_admin.
 * The page registry on the frontend (serpbays_admin/src/lib/admin-pages.ts)
 * must mirror this list — keep them in sync.
 *
 * `hasDelete: true` on a registry entry means this page has at least one
 * delete-style API action and the permission grid should show a Delete
 * checkbox for it. Pages without hasDelete still expose Edit, which covers
 * non-destructive mutations (approve, reject, transfer, update, etc.).
 *
 * Pages excluded from this registry:
 *   - "dashboard"        always granted to any admin (landing page)
 *   - "role-management"  super_admin only, not assignable
 *   - "access-denied"    public error page
 */

const ADMIN_PAGES = [
  { key: 'users',            label: 'Users',            hasDelete: true  },
  { key: 'orders',           label: 'Orders',           hasDelete: false },
  { key: 'websites',         label: 'Websites',         hasDelete: true  },
  { key: 'marketplace',      label: 'Marketplace',      hasDelete: true  },
  { key: 'website-requests', label: 'Website Requests', hasDelete: false },
  { key: 'shared-lists',     label: 'Shared Lists',     hasDelete: true  },
  { key: 'communications',   label: 'Communications',   hasDelete: true  },
  { key: 'transactions',     label: 'Transactions',     hasDelete: false },
  { key: 'wallets',          label: 'Wallets',          hasDelete: false },
  { key: 'withdrawals',      label: 'Withdrawals',      hasDelete: false },
  { key: 'codes',            label: 'Codes',            hasDelete: true  },
  { key: 'offers',           label: 'Offers',           hasDelete: true  },
  { key: 'analytics',        label: 'Analytics',        hasDelete: false },
  { key: 'settings',         label: 'Settings',         hasDelete: false },
  { key: 'audit-logs',       label: 'Audit Logs',       hasDelete: false },
];

const ADMIN_PAGE_KEYS = ADMIN_PAGES.map((p) => p.key);
const PAGES_WITH_DELETE = new Set(
  ADMIN_PAGES.filter((p) => p.hasDelete).map((p) => p.key),
);

function emptyPermissions() {
  const out = {};
  for (const key of ADMIN_PAGE_KEYS) {
    out[key] = { view: false, edit: false, delete: false };
  }
  return out;
}

function allPermissions() {
  const out = {};
  for (const key of ADMIN_PAGE_KEYS) {
    out[key] = {
      view: true,
      edit: true,
      // delete only synthesizes true on pages that actually have a delete
      // action — keeps super_admin's resolved map honest about what exists.
      delete: PAGES_WITH_DELETE.has(key),
    };
  }
  return out;
}

/**
 * Normalize an arbitrary stored value into a complete permission map.
 * Unknown keys are dropped; missing keys default to false. Pages without
 * hasDelete always coerce delete back to false so a stale stored value
 * can't grant a permission that does nothing.
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
  PAGES_WITH_DELETE,
  emptyPermissions,
  allPermissions,
  normalizePermissions,
  resolvePermissions,
};
