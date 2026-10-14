'use strict';

// Partner portal routes (2026-10-14). The authenticated-role grants are added at boot in src/index.js.
module.exports = {
  routes: [
    { method: 'GET', path: '/partner-portal/me', handler: 'partner-portal.me', config: { policies: [] } },
    { method: 'PUT', path: '/partner-portal/me', handler: 'partner-portal.update', config: { policies: [{ name: 'global::simple-rate-limit', config: { interval: 60000, max: 20 } }] } },
    { method: 'POST', path: '/partner-portal/me/document', handler: 'partner-portal.uploadDocument', config: { policies: [{ name: 'global::simple-rate-limit', config: { interval: 60000, max: 5 } }] } },
    { method: 'GET', path: '/partner-portal/statement', handler: 'partner-portal.statement', config: { policies: [{ name: 'global::simple-rate-limit', config: { interval: 60000, max: 10 } }] } },
    // no IP rate limit here: one application per account is enforced in the controller, and shared IPs (offices, mobile carriers) were hitting it
    { method: 'POST', path: '/partner-portal/apply', handler: 'partner-portal.apply', config: { policies: [] } },
    { method: 'POST', path: '/partner-portal/apply-public', handler: 'partner-portal.applyPublic', config: { auth: false, policies: [{ name: 'global::simple-rate-limit', config: { interval: 3600000, max: 5 } }] } },
  ],
};
