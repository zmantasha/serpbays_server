'use strict';

module.exports = {
  routes: [
    // {
    //   method: 'GET',
    //   path: '/projects/my/all',
    //   handler: 'api::project.project.getMyProjects',
    //   config: {
    //     policies: ['api::project.is-authenticated'],
    //     middlewares: [],
    //   }
    // },
    {
      method: 'GET',
      path: '/projects/templates',
      handler: 'api::project.project.getTemplates',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'POST',
      path: '/projects/from-template',
      handler: 'api::project.project.createFromTemplate',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    // {
    //   method: 'POST',
    //   path: '/projects/:id/team',
    //   handler: 'api::project.project.addTeamMembers',
    //   config: {
    //     policies: ['api::project.is-authenticated'],
    //     middlewares: [],
    //   }
    // },
    {
      method: 'GET',
      path: '/projects/:id/analytics',
      handler: 'api::project.project.getAnalytics',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'PUT',
      path: '/projects/:id/metrics',
      handler: 'api::project.project.updateMetrics',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'PUT',
      path: '/projects/:id/archive',
      handler: 'api::project.project.archiveProject',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'PUT',
      path: '/projects/:id/unarchive',
      handler: 'api::project.project.unarchiveProject',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    }
  ]
}; 