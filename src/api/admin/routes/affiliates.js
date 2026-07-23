'use strict';

/**
 * Admin routes for the affiliate program.
 * Every route is gated by `global::is-admin` (policy) + `global::admin-jwt-auth`
 * (middleware) — same pattern as the rest of the /admin surface (users,
 * wallets, transactions, withdrawals, etc). A non-admin JWT will 403 at
 * the policy layer before reaching the controller.
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/admin/affiliates',
      handler: 'affiliates.find',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    {
      method: 'GET',
      path: '/admin/affiliates/:id',
      handler: 'affiliates.findOne',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    {
      method: 'PUT',
      path: '/admin/affiliates/:id/disable',
      handler: 'affiliates.disable',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    {
      method: 'PUT',
      path: '/admin/affiliates/:id/enable',
      handler: 'affiliates.enable',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    {
      method: 'PUT',
      path: '/admin/affiliates/:id/regenerate-code',
      handler: 'affiliates.regenerateCode',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    {
      method: 'PUT',
      path: '/admin/affiliates/:id/terminate',
      handler: 'affiliates.terminate',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    {
      method: 'GET',
      path: '/admin/affiliates/:id/referrals',
      handler: 'affiliates.referrals',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    // ── Commission controls (per-affiliate) ──────────────────────────
    {
      method: 'PUT',
      path: '/admin/affiliates/:id/commissions/enable',
      handler: 'affiliates.enableCommissions',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    {
      method: 'PUT',
      path: '/admin/affiliates/:id/commissions/disable',
      handler: 'affiliates.disableCommissions',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
    {
      method: 'GET',
      path: '/admin/affiliates/:id/commissions',
      handler: 'affiliates.commissions',
      config: { policies: ['global::is-admin'], middlewares: ['global::admin-jwt-auth'] },
    },
  ],
};
