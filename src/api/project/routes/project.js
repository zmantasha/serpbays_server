'use strict';

/**
 * project router
 */

const { createCoreController } = require('@strapi/strapi').factories;

// Create a custom controller to extend the core controller
const customController = ({ strapi }) => ({
  async findOne(ctx) {
    const { id } = ctx.params;
    const entity = await strapi.entityService.findOne('api::project.project', id, {
      populate: ['owner', 'team', 'orders']
    });

    if (!entity) {
      return ctx.notFound('Project not found');
    }

    const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitizedEntity);
  }
});

// Export the core router with custom configuration
module.exports = {
  routes: [
    // Core routes
    {
      method: 'GET',
      path: '/api/projects',
      handler: 'api::project.project.find',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'GET',
      path: '/api/projects/:id',
      handler: 'api::project.project.findOne',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'POST',
      path: '/api/projects',
      handler: 'api::project.project.create',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'PUT',
      path: '/api/projects/:id',
      handler: 'api::project.project.update',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    {
      method: 'DELETE',
      path: '/api/projects/:id',
      handler: 'api::project.project.delete',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    },
    // Custom routes
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
      method: 'POST',
      path: '/api/projects/:id/team',
      handler: 'api::project.project.addTeamMembers',
      config: {
        policies: ['api::project.is-authenticated'],
        middlewares: [],
      }
    }
  ]
};
