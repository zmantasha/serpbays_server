'use strict';

/**
 * Single source of truth for gateable admin pages.
 *
 * Each key maps to a top-level route segment in serpbays_admin.
 * The page registry on the frontend (serpbays_admin/src/lib/admin-pages.ts)
 * must mirror this list — keep them in sync.
 *
 * Pages excluded from this registry:
 *   - "dashboard"        always granted to any admin (landing page)
 *   - "role-management"  super_admin only, not assignable
 *   - "access-denied"    public error page
 */

const ADMIN_PAGES = [
  { key: 'users',            label: 'Users' },
  { key: 'orders',           label: 'Orders' },
  { key: 'websites',         label: 'Websites' },
  { key: 'marketplace',      label: 'Marketplace' },
  { key: 'website-requests', label: 'Website Requests' },
  { key: 'shared-lists',     label: 'Shared Lists' },
  { key: 'communications',   label: 'Communications' },
  { key: 'transactions',     label: 'Transactions' },
  { key: 'wallets',          label: 'Wallets' },
  { key: 'withdrawals',      label: 'Withdrawals' },
  { key: 'codes',            label: 'Codes' },
  { key: 'offers',           label: 'Offers' },
  { key: 'analytics',        label: 'Analytics' },
  { key: 'settings',         label: 'Settings' },
  { key: 'audit-logs',       label: 'Audit Logs' },
];

const ADMIN_PAGE_KEYS = ADMIN_PAGES.map((p) => p.key);

function emptyPermissions() {
  const out = {};
  for (const key of ADMIN_PAGE_KEYS) {
    out[key] = { view: false, edit: false };
  }
  return out;
}

function allPermissions() {
  const out = {};
  for (const key of ADMIN_PAGE_KEYS) {
    out[key] = { view: true, edit: true };
  }
  return out;
}

/**
 * Normalize an arbitrary stored value into a complete permission map.
 * Unknown keys are dropped; missing keys default to false.
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
  emptyPermissions,
  allPermissions,
  normalizePermissions,
  resolvePermissions,
};
