'use strict';

// Reading the queue needs any admin; decisions need edit rights on Websites.
const view = { auth: false, policies: ['global::is-admin-with-jwt'], middlewares: ['global::admin-logger'] };
const edit = { auth: false, policies: ['global::is-admin-with-jwt', { name: 'global::requires-edit', config: { pageKey: 'websites' } }], middlewares: ['global::admin-logger'] };

module.exports = {
  routes: [
    { method: 'GET', path: '/admin/moderation/summary', handler: 'moderation.summary', config: view },
    { method: 'GET', path: '/admin/moderation/edits', handler: 'moderation.edits', config: view },
    { method: 'POST', path: '/admin/moderation/edits/decide', handler: 'moderation.decideEdits', config: edit },
    { method: 'GET', path: '/admin/moderation/sites', handler: 'moderation.sites', config: view },
    { method: 'POST', path: '/admin/moderation/sites/decide', handler: 'moderation.decideSites', config: edit },
    { method: 'GET', path: '/admin/moderation/sites/:id', handler: 'moderation.site', config: view },
    { method: 'POST', path: '/admin/moderation/sites/:id/checks', handler: 'moderation.runChecks', config: edit },
    { method: 'POST', path: '/admin/moderation/triage/run', handler: 'moderation.triageRun', config: edit },
    { method: 'GET', path: '/admin/moderation/triage/status', handler: 'moderation.triageStatus', config: view },
    { method: 'GET', path: '/admin/moderation/flags', handler: 'moderation.flags', config: view },
    { method: 'POST', path: '/admin/moderation/flags/scan', handler: 'moderation.flagsScan', config: edit },
    { method: 'POST', path: '/admin/moderation/flags/:id/resolve', handler: 'moderation.flagResolve', config: edit },
    { method: 'POST', path: '/admin/moderation/lock', handler: 'moderation.lock', config: view },
    { method: 'POST', path: '/admin/moderation/unlock', handler: 'moderation.unlock', config: view },
    { method: 'GET', path: '/admin/moderation/stats', handler: 'moderation.stats', config: view },
    { method: 'PUT', path: '/admin/moderation/settings', handler: 'moderation.saveSettings', config: view },
  ],
};
