'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/api/projects/my/all',
      handler: 'api::project.project.getMyProjects',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'GET',
      path: '/api/projects/templates',
      handler: 'api::project.project.getTemplates',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'POST',
      path: '/api/projects/from-template',
      handler: 'api::project.project.createFromTemplate',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'POST',
      path: '/api/projects/:id/team',
      handler: 'api::project.project.addTeamMembers',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'GET',
      path: '/api/projects/:id/analytics',
      handler: 'api::project.project.getAnalytics',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'PUT',
      path: '/api/projects/:id/metrics',
      handler: 'api::project.project.updateMetrics',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    }
  ]
}; 