'use strict';

/**
 * project controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::project.project', ({ strapi }) => ({
  // Create a new project
  async create(ctx) {
    try {
      const { user } = ctx.state;
      if (!user) {
        return ctx.unauthorized('You must be logged in to create a project');
      }

      // Get the request body data
      const { data } = ctx.request.body;

      if (!data || !data.ProjectName || !data.projectUrl) {
        return ctx.badRequest('Project name and URL are required');
      }

      // Check if project name already exists for the current user
      const existingProject = await strapi.db.query('api::project.project').findOne({
        where: { 
          ProjectName: data.ProjectName,
          owner: user.id
        }
      });

      if (existingProject) {
        return ctx.badRequest('You already have a project with this name. Please choose a different name.');
      }

      // Add the current user as owner and required fields
      const projectData = {
        ...data,
        owner: user.id,
        startDate: data.startDate || new Date().toISOString(),
        publishedAt: data.publishedAt || new Date().toISOString()
      };

      // Create the project
      const entity = await strapi.entityService.create('api::project.project', {
        data: projectData,
        populate: ['owner', 'team', 'files']
      });

      const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      console.error('Project creation error:', error);
      return ctx.badRequest('Failed to create project', { error: error.message });
    }
  },

  // Get a single project
  async findOne(ctx) {
    const { id } = ctx.params;
    const { user } = ctx.state;

    try {
      const entity = await strapi.entityService.findOne('api::project.project', id, {
        populate: ['owner', 'team', 'orders', 'files']
      });

      if (!entity) {
        return ctx.notFound('Project not found');
      }

      // Check if user has access to this project
      const hasAccess = 
        entity.owner.id === user.id || 
        entity.team?.some(member => member.id === user.id);

      if (!hasAccess) {
        return ctx.forbidden('You do not have access to this project');
      }

      const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      console.error('Project fetch error:', error);
      return ctx.badRequest('Failed to fetch project', { error: error.message });
    }
  },

  // Get projects for current user
  async getMyProjects(ctx) {
    const { user } = ctx.state;
    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    try {
      // Build filters
      const filters = {
        $or: [
          { owner: user.id },
          { team: { id: user.id } }
        ]
      };

      // Get pagination parameters from query
      const { pagination } = ctx.query;
      const page = pagination?.page ? parseInt(pagination.page) : 1;
      const pageSize = pagination?.pageSize ? parseInt(pagination.pageSize) : 25;
      const start = (page - 1) * pageSize;

      // Get total count first
      const totalCount = await strapi.db.query('api::project.project').count({
        where: filters
      });

      // Get paginated projects
      const projects = await strapi.entityService.findMany('api::project.project', {
        filters,
        populate: ['owner', 'team', 'orders', 'files'],
        sort: { createdAt: 'desc' },
        start,
        limit: pageSize
      });

      // Calculate pagination metadata
      const pageCount = Math.ceil(totalCount / pageSize);

      return {
        data: projects,
        meta: {
          pagination: {
            page,
            pageSize,
            pageCount,
            total: totalCount
          }
        }
      };
    } catch (error) {
      return ctx.badRequest('Failed to fetch projects', { error: error.message });
    }
  },

  // Get project templates
  async getTemplates(ctx) {
    try {
      const templates = await strapi.entityService.findMany('api::project.project', {
        filters: {
          template: true
        },
        populate: ['contentGuidelines', 'brandVoiceGuidelines']
      });

      return {
        data: templates
      };
    } catch (error) {
      return ctx.badRequest('Failed to fetch templates', { error: error.message });
    }
  },

  // Create project from template
  async createFromTemplate(ctx) {
    const { user } = ctx.state;
    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    try {
      const { templateId, projectName } = ctx.request.body;
      
      // Get the template
      const template = await strapi.entityService.findOne('api::project.project', templateId, {
        populate: '*'
      });

      if (!template || !template.template) {
        return ctx.notFound('Template not found');
      }

      // Create new project from template
      const newProject = {
        name: projectName,
        description: template.description,
        category: template.category,
        contentGuidelines: template.contentGuidelines,
        brandVoiceGuidelines: template.brandVoiceGuidelines,
        owner: user.id,
        startDate: new Date().toISOString(),
        status: 'active',
        template: false,
        publishedAt: new Date().toISOString()
      };

      const project = await strapi.entityService.create('api::project.project', {
        data: newProject,
        populate: ['owner', 'team']
      });

      return {
        data: project
      };
    } catch (error) {
      return ctx.badRequest('Failed to create project from template', { error: error.message });
    }
  },

  // Add team members to project
  async addTeamMembers(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;
    const { userIds } = ctx.request.body;

    try {
      // Check if user is project owner
      const project = await strapi.entityService.findOne('api::project.project', id, {
        populate: ['owner', 'team']
      });

      if (!project) {
        return ctx.notFound('Project not found');
      }

      if (project.owner.id !== user.id) {
        return ctx.forbidden('Only project owner can add team members');
      }

      // Add team members
      const updatedProject = await strapi.entityService.update('api::project.project', id, {
        data: {
          team: [...(project.team?.map(t => t.id) || []), ...userIds]
        },
        populate: ['owner', 'team']
      });

      return {
        data: updatedProject
      };
    } catch (error) {
      return ctx.badRequest('Failed to add team members', { error: error.message });
    }
  },

  // Get project analytics
  async getAnalytics(ctx) {
    const { id } = ctx.params;

    try {
      const project = await strapi.entityService.findOne('api::project.project', id, {
        populate: ['orders']
      });

      if (!project) {
        return ctx.notFound('Project not found');
      }

      // Calculate analytics
      const totalOrders = project.orders?.length || 0;
      const completedOrders = project.orders?.filter(o => o.orderStatus === 'completed').length || 0;
      const completionRate = totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0;
      const budgetUtilization = project.totalBudget > 0 ? (project.usedBudget / project.totalBudget) * 100 : 0;

      return {
        data: {
          totalOrders,
          completedOrders,
          completionRate,
          budgetUtilization,
          metrics: project.metrics || {}
        }
      };
    } catch (error) {
      return ctx.badRequest('Failed to fetch analytics', { error: error.message });
    }
  },

  // Update project metrics
  async updateMetrics(ctx) {
    const { id } = ctx.params;
    const { metrics } = ctx.request.body;

    try {
      const project = await strapi.entityService.findOne('api::project.project', id);

      if (!project) {
        return ctx.notFound('Project not found');
      }

      const updatedProject = await strapi.entityService.update('api::project.project', id, {
        data: {
          metrics: {
            ...(project.metrics || {}),
            ...metrics
          }
        }
      });

      return {
        data: updatedProject
      };
    } catch (error) {
      return ctx.badRequest('Failed to update metrics', { error: error.message });
    }
  }
}));
