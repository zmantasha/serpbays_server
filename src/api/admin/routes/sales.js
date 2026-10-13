'use strict';

// Sales follow-up (CRM-lite), 2026-10-13. Permissions are checked in the controller.
const cfg = { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] };
module.exports = {
  routes: [
    { method: 'GET', path: '/admin/sales/queue', handler: 'sales.getQueue', config: cfg },
    { method: 'GET', path: '/admin/sales/leads/:userId', handler: 'sales.getLead', config: cfg },
    { method: 'PUT', path: '/admin/sales/leads/:userId', handler: 'sales.setLead', config: cfg },
  ],
};
