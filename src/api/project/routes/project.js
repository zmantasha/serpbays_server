'use strict';

/**
 * project router
 *
 * NOTE: a `customController` block previously defined here had an
 * unauthenticated `findOne` (full populate, no ownership check). It was
 * never wired (route uses `handler: 'api::project.project.findOne'`
 * which resolves to controllers/project.js), but the dead code was
 * removed to prevent a future routing change from accidentally exposing
 * an instant IDOR. All routes below are gated by `api::project.is-authenticated`.
 */

module.exports = {
  routes: [
    // Core routes
    {
      method: 'GET',
      path: '/projects',
      handler: 'api::project.project.find',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'GET',
      path: '/projects/:id',
      handler: 'api::project.project.findOne',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'POST',
      path: '/projects',
      handler: 'api::project.project.create',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'PUT',
      path: '/projects/:id',
      handler: 'api::project.project.update',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'DELETE',
      path: '/projects/:id',
      handler: 'api::project.project.delete',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    // Custom routes
    {
      method: 'GET',
      path: '/projects/my/all',
      handler: 'api::project.project.getMyProjects',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'POST',
      path: '/projects/:id/team',
      handler: 'api::project.project.addTeamMembers',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    }
  ]
};
