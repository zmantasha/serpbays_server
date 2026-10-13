'use strict';

/**
 * User insights routes (directory, profile, notes, tags, type). Same auth
 * pattern as dashboard.js: auth:false + is-admin-with-jwt policy.
 * NOTE: '/admin/users/directory' must not collide with '/admin/users/:id' —
 * Strapi matches static segments before params, and ':id' is parsed as an
 * int in users.findOne anyway.
 */
// 2026-10-13: page permission added (was admin-only).
const cfg = { auth: false, policies: ['global::is-admin-with-jwt', { name: 'global::requires-view', config: { pageKey: 'users' } }], middlewares: ['global::admin-logger'] };
const editCfg = { auth: false, policies: ['global::is-admin-with-jwt', { name: 'global::requires-edit', config: { pageKey: 'users' } }], middlewares: ['global::admin-logger'] };
module.exports = {
  routes: [
    { method: 'GET', path: '/admin/users/directory', handler: 'user-insights.directory', config: cfg },
    { method: 'GET', path: '/admin/users/:id/profile', handler: 'user-insights.profile', config: cfg },
    { method: 'POST', path: '/admin/users/:id/notes', handler: 'user-insights.addNote', config: editCfg },
    { method: 'PUT', path: '/admin/users/:id/tags', handler: 'user-insights.setTags', config: editCfg },
    { method: 'PUT', path: '/admin/users/:id/type', handler: 'user-insights.setType', config: editCfg },
  ],
};
