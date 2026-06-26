'use strict';

/**
 * project controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

// PII discipline for project responses (2026-06-25 audit).
// Pre-fix: every populate of `owner` and `team` returned the full
// up_users row (email, username, phone, password hash, withdrawalOtp,
// paypal_email, billing PII). 14 broad populates across the controller
// — every user-facing handler leaked.
// Post-fix: relations are clipped to { id }. UI consumption verified
// by grep across serpbays_client — only `project.team.length` is read.
// Owner identity is implied (the caller IS the owner on getMyProjects);
// no further surface is needed.
const PROJECT_USER_FIELDS = ['id'];

// Allow-listed scalar fields on the project row itself. Mirrors the
// order-controller pattern: only what the UI consumes; admin/internal
// columns excluded. `publishedAt` IS included because project schema
// has `draftAndPublish: true` (verified via schema.json).
const PROJECT_PUBLIC_FIELDS = [
  'id', 'documentId',
  'ProjectName', 'projectUrl',
  'startDate', 'archived', 'status',
  'createdAt', 'updatedAt', 'publishedAt',
];

// Standard nested populate for project list/detail responses. Every
// relation is `{ fields: [...] }` not `: true` — a future schema
// addition (e.g. a PII column on a related type) can't auto-leak.
const PROJECT_LIST_POPULATE = {
  owner:  { fields: PROJECT_USER_FIELDS },
  team:   { fields: PROJECT_USER_FIELDS },
  orders: { fields: ['id', 'orderStatus'] },
  files:  { fields: ['id', 'url', 'name', 'mime', 'size', 'alternativeText'] },
};

// Defense-in-depth response shaper. Even when an internal handler uses
// a broad populate (for auth checks or internal email composition),
// this strips owner/team to { id } before the response is sent.
function sanitizeProjectResponse(project) {
  if (!project || typeof project !== 'object') return project;
  if (project.owner && typeof project.owner === 'object') {
    project.owner = { id: project.owner.id };
  }
  if (Array.isArray(project.team)) {
    project.team = project.team.map(m => (m && typeof m === 'object') ? { id: m.id } : m);
  } else if (project.team && typeof project.team === 'object') {
    project.team = { id: project.team.id };
  }
  return project;
}

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
        populate: { owner: { fields: PROJECT_USER_FIELDS }, team: { fields: PROJECT_USER_FIELDS }, files: { fields: ['id', 'url', 'name', 'mime', 'size', 'alternativeText'] } }
      });

      // Send project created email via AutoSend
      try {
        await strapi.service('api::global.email-operations').sendProjectCreatedEmail(entity, user);
      } catch (emailError) {
        console.error('[AutoSend] Failed to send project creation email:', emailError.message);
      }

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
        populate: PROJECT_LIST_POPULATE
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

  // Get projects for current user.
  //
  // SECURITY — relation field allow-lists:
  //   populate: PROJECT_LIST_POPULATE expanded full user objects
  //   from up_users, leaking password hash, resetPasswordToken,
  //   confirmationToken, *active withdrawal OTPs*, PayPal / Payoneer payout
  //   emails, billing address, phone, VAT/GST, clerk_id, tokenVersion, and
  //   pagePermissions for every owner + team member of every project
  //   returned. `private: true` in the schema is only enforced by
  //   `sanitizeOutput`, which this handler bypassed by returning the raw
  //   findMany result. Each relation now has an explicit `fields` allow-list;
  //   future schema additions on up_users / order will NOT auto-leak.
  async getMyProjects(ctx) {
    const { user } = ctx.state;
    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    try {
      const filters = {
        $or: [
          { owner: user.id },
          { team: { id: user.id } }
        ]
      };

      // Pagination with hard caps. Without these a hostile caller could
      // request pageSize=10_000_000 and exhaust DB/memory.
      const { pagination } = ctx.query;
      const rawPage = Number.parseInt(pagination?.page, 10);
      const rawPageSize = Number.parseInt(pagination?.pageSize, 10);
      const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
      const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1
        ? Math.min(rawPageSize, 100)
        : 9;
      const start = (page - 1) * pageSize;

      const totalCount = await strapi.db.query('api::project.project').count({
        where: filters
      });

      const projects = await strapi.entityService.findMany('api::project.project', {
        filters,
        fields: PROJECT_PUBLIC_FIELDS,
        populate: PROJECT_LIST_POPULATE,
        sort: { createdAt: 'desc' },
        start,
        limit: pageSize
      });

      const pageCount = Math.ceil(totalCount / pageSize);

      return {
        data: projects.map(sanitizeProjectResponse),
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
      strapi.log?.error?.('[project] getMyProjects failed', { error: error.message });
      return ctx.badRequest('Failed to fetch projects');
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
      
      // KNOWN BROKEN — see follow-up note below. The fields requested here
      // (`description`, `category`, `contentGuidelines`, `brandVoiceGuidelines`,
      // `template`) do NOT exist on the project schema (verified against
      // src/api/project/content-types/project/schema.json AND the actual
      // `projects` table — no such columns). The endpoint references a
      // partially-shipped "template" feature whose schema attributes were
      // never landed.
      //
      // My pass-10B fix replaced `populate: '*'` with this `fields:[]` —
      // but every key in that list is bogus, so under Strapi 5's stricter
      // query-fields validator this call throws ValidationError before
      // anything else runs.
      //
      // Defensive fix: remove the `fields:[]` constraint so the findOne
      // returns the bare schema (id + scalars that DO exist). The
      // downstream `if (!template.template)` will short-circuit to 404
      // cleanly since template.template is undefined. Endpoint stays
      // non-functional but no longer 500s.
      //
      // Follow-up: either ship the template-feature schema attributes via
      // a migration, or remove this endpoint entirely.
      const template = await strapi.entityService.findOne('api::project.project', templateId);

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
        populate: { owner: { fields: PROJECT_USER_FIELDS }, team: { fields: PROJECT_USER_FIELDS } }
      });

      return {
        data: sanitizeProjectResponse(project)
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
        populate: { owner: { fields: PROJECT_USER_FIELDS }, team: { fields: PROJECT_USER_FIELDS } }
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
        populate: { owner: { fields: PROJECT_USER_FIELDS }, team: { fields: PROJECT_USER_FIELDS } }
      });

      return {
        data: sanitizeProjectResponse(updatedProject)
      };
    } catch (error) {
      return ctx.badRequest('Failed to add team members', { error: error.message });
    }
  },

  // Get project analytics. Owner OR team member only — pre-fix, any
  // authenticated user could read order counts / budget utilization /
  // arbitrary `metrics` for any project (read-IDOR). 404 on no-access to
  // avoid enumerating project IDs.
  async getAnalytics(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;

    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('Project not found');
    }

    try {
      // KNOWN BROKEN — same shape as createFromTemplate above. The fields
      // `totalBudget`, `usedBudget`, `metrics` do NOT exist on the project
      // schema (verified at the DB level — no such columns on the
      // `projects` table). budgetUtilization downstream reads will resolve
      // to undefined and `metrics: project.metrics || {}` already guards
      // for that. Drop the fields:[] so the call doesn't throw Strapi 5
      // ValidationError; everything else degrades gracefully to zeros.
      const project = await strapi.entityService.findOne('api::project.project', numericId, {
        populate: {
          owner: { fields: ['id'] },
          team:  { fields: ['id'] },
          orders: { fields: ['id', 'orderStatus'] },
        },
      });

      if (!project) {
        return ctx.notFound('Project not found');
      }

      const hasAccess =
        project.owner?.id === user.id ||
        (Array.isArray(project.team) && project.team.some(m => m && m.id === user.id));
      if (!hasAccess) {
        return ctx.notFound('Project not found');
      }

      const totalOrders = project.orders?.length || 0;
      const completedOrders = project.orders?.filter(o => o.orderStatus === 'completed').length || 0;
      const completionRate = totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0;
      const budgetUtilization = project.totalBudget > 0
        ? ((project.usedBudget || 0) / project.totalBudget) * 100
        : 0;

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
      strapi.log?.error?.('[project] getAnalytics failed', { error: error.message });
      return ctx.badRequest('Failed to fetch analytics');
    }
  },

  // Update project metrics. Owner-only write — pre-fix, any authenticated
  // user could overwrite the `metrics` JSON on any project (write-IDOR).
  // 404 on no-access to avoid enumerating project IDs.
  async updateMetrics(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;
    const { metrics } = ctx.request.body || {};

    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('Project not found');
    }

    // Reject anything other than a plain object — arrays / scalars / nulls
    // would corrupt the JSON column or replace it wholesale.
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
      return ctx.badRequest('metrics must be a plain object');
    }

    try {
      // KNOWN BROKEN — `metrics` is not on the project schema (the
      // updateMetrics endpoint persists data that has no column to land in).
      // The endpoint chain (find → ownership-check → entityService.update
      // with { metrics }) effectively becomes a 200 with no DB write.
      // Drop the fields:[] so Strapi 5's query-fields validator doesn't
      // throw before the ownership check runs. Follow-up: add `metrics`
      // as a `type: "json"` attribute via migration, or remove this endpoint.
      const project = await strapi.entityService.findOne('api::project.project', numericId, {
        populate: { owner: { fields: ['id'] } },
      });

      if (!project) {
        return ctx.notFound('Project not found');
      }

      if (project.owner?.id !== user.id) {
        return ctx.notFound('Project not found');
      }

      const updatedProject = await strapi.entityService.update('api::project.project', numericId, {
        data: {
          metrics: {
            ...(project.metrics || {}),
            ...metrics
          }
        },
        fields: ['id', 'metrics'],
      });

      return {
        data: {
          id: updatedProject.id,
          metrics: updatedProject.metrics || {},
        }
      };
    } catch (error) {
      strapi.log?.error?.('[project] updateMetrics failed', { error: error.message });
      return ctx.badRequest('Failed to update metrics');
    }
  },

  // Update a project (with access control)
  async update(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;

    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    try {
      // Check if project exists and user has access
      const project = await strapi.entityService.findOne('api::project.project', id, {
        populate: { owner: { fields: PROJECT_USER_FIELDS }, team: { fields: PROJECT_USER_FIELDS } }
      });

      if (!project) {
        return ctx.notFound('Project not found');
      }

      // Check if user is the owner (only owners can update projects)
      if (project.owner.id !== user.id) {
        return ctx.forbidden('Only project owner can update this project');
      }

      // Update the project
      const updatedProject = await strapi.entityService.update('api::project.project', id, {
        data: ctx.request.body.data || ctx.request.body,
        populate: PROJECT_LIST_POPULATE
      });

      const sanitizedEntity = await this.sanitizeOutput(updatedProject, ctx);
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      console.error('Update project error:', error);
      return ctx.badRequest('Failed to update project', { error: error.message });
    }
  },

  // Delete a project (with access control)
  async delete(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;

    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    try {
      // Check if project exists and user has access
      const project = await strapi.entityService.findOne('api::project.project', id, {
        populate: { owner: { fields: PROJECT_USER_FIELDS }, team: { fields: PROJECT_USER_FIELDS } }
      });

      if (!project) {
        return ctx.notFound('Project not found');
      }

      // Check if user is the owner (only owners can delete projects)
      if (project.owner.id !== user.id) {
        return ctx.forbidden('Only project owner can delete this project');
      }

      // Delete the project
      const deletedProject = await strapi.entityService.delete('api::project.project', id);

      const sanitizedEntity = await this.sanitizeOutput(deletedProject, ctx);
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      console.error('Delete project error:', error);
      return ctx.badRequest('Failed to delete project', { error: error.message });
    }
  },

  // Archive a project
  async archiveProject(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;

    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    try {
      // Check if project exists and user has access
      const project = await strapi.entityService.findOne('api::project.project', id, {
        populate: { owner: { fields: PROJECT_USER_FIELDS }, team: { fields: PROJECT_USER_FIELDS } }
      });

      if (!project) {
        return ctx.notFound('Project not found');
      }

      // Check if user has access to this project
      const hasAccess = 
        project.owner.id === user.id || 
        project.team?.some(member => member.id === user.id);

      if (!hasAccess) {
        return ctx.forbidden('You do not have access to this project');
      }

      // Archive the project
      const archivedProject = await strapi.entityService.update('api::project.project', id, {
        data: {
          archived: true,
          status: 'archived'
        },
        populate: PROJECT_LIST_POPULATE
      });

      const sanitizedEntity = await this.sanitizeOutput(archivedProject, ctx);
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      console.error('Archive project error:', error);
      return ctx.badRequest('Failed to archive project', { error: error.message });
    }
  },

  // Unarchive a project
  async unarchiveProject(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;

    if (!user) {
      return ctx.unauthorized('Authentication required');
    }

    try {
      // Check if project exists and user has access
      const project = await strapi.entityService.findOne('api::project.project', id, {
        populate: { owner: { fields: PROJECT_USER_FIELDS }, team: { fields: PROJECT_USER_FIELDS } }
      });

      if (!project) {
        return ctx.notFound('Project not found');
      }

      // Check if user has access to this project
      const hasAccess = 
        project.owner.id === user.id || 
        project.team?.some(member => member.id === user.id);

      if (!hasAccess) {
        return ctx.forbidden('You do not have access to this project');
      }

      // Unarchive the project
      const unarchivedProject = await strapi.entityService.update('api::project.project', id, {
        data: {
          archived: false,
          status: 'active'
        },
        populate: PROJECT_LIST_POPULATE
      });

      const sanitizedEntity = await this.sanitizeOutput(unarchivedProject, ctx);
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      console.error('Unarchive project error:', error);
      return ctx.badRequest('Failed to unarchive project', { error: error.message });
    }
  }
}));
