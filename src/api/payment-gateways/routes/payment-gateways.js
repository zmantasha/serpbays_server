'use strict';

/**
 * Payment Gateways Router
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/payment-gateways/enabled',
      handler: 'payment-gateways.getEnabled',
      config: {
        auth: false // Allow public access to check enabled gateways
      }
    },
    {
      method: 'POST',
      path: '/payment-gateways/calculate-fees',
      handler: 'payment-gateways.calculateFees',
      config: {
        auth: false // Allow public access for fee calculation
      }
    },
    {
      // SECURITY: pre-fix used `auth.scope: ['admin']` — Strapi matches
      // scope against permission action names in up_permissions, not role
      // types. No action named 'admin' exists, so the route was
      // unreachable for ALL users including admins. Replaced with the
      // project's `global::is-admin` policy (role.type-based) — same fix
      // applied to bank-transfer-request in Pass 7.
      method: 'PUT',
      path: '/payment-gateways/settings',
      handler: 'payment-gateways.updateSettings',
      config: {
        auth: {
          strategies: ['jwt'],
        },
        policies: ['global::is-admin'],
      },
    }
  ]
};
