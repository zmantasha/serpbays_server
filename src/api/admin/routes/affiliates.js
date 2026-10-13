'use strict';

// Affiliate program admin routes (super admin checked in the controller), 2026-10-14.
const cfg = { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] };
module.exports = {
  routes: [
    { method: 'GET', path: '/admin/affiliates', handler: 'affiliates.list', config: cfg },
    { method: 'POST', path: '/admin/affiliates', handler: 'affiliates.create', config: cfg },
    { method: 'GET', path: '/admin/affiliates/flags', handler: 'affiliates.flags', config: cfg },
    { method: 'PUT', path: '/admin/affiliates/flags/:id', handler: 'affiliates.updateFlag', config: cfg },
    { method: 'GET', path: '/admin/affiliates/payouts', handler: 'affiliates.payouts', config: cfg },
    { method: 'POST', path: '/admin/affiliates/payouts/run', handler: 'affiliates.runPayouts', config: cfg },
    { method: 'PUT', path: '/admin/affiliates/payouts/:id', handler: 'affiliates.updatePayout', config: cfg },
    { method: 'POST', path: '/admin/affiliates/jobs/:name', handler: 'affiliates.runJob', config: cfg },
    { method: 'GET', path: '/admin/affiliates/:id', handler: 'affiliates.detail', config: cfg },
    { method: 'PUT', path: '/admin/affiliates/:id', handler: 'affiliates.update', config: cfg },
    { method: 'POST', path: '/admin/affiliates/:id/adjust', handler: 'affiliates.adjust', config: cfg },
    { method: 'POST', path: '/admin/affiliates/:id/referrals', handler: 'affiliates.attachReferral', config: cfg },
    { method: 'GET', path: '/admin/affiliates/:id/statement', handler: 'affiliates.statement', config: cfg },
  ],
};
