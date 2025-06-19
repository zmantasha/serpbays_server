'use strict';

/**
 * shortlist controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::shortlist.shortlist', ({ strapi }) => ({
  async create(ctx) {
    const { user } = ctx.state;
    const { project, marketplace, notes } = ctx.request.body.data;
    console.log("project",project)
    console.log("marketplace",marketplace)
    console.log("notes",notes)
    if (!user) {
      return ctx.unauthorized('You must be logged in to create a shortlist item.');
    }

    if (!project || !marketplace) {
        return ctx.badRequest('Project and Marketplace are required.');
    }

    // Check if item already exists
    const existing = await strapi.db.query('api::shortlist.shortlist').findOne({
      where: {
        project: project,
        marketplace: marketplace,
        owner: user.id,
      },
    });

    console.log("existing", existing)

    if (existing) {
      return ctx.badRequest('This item is already shortlisted for this project.');
    }

    const entity = await strapi.service('api::shortlist.shortlist').create({
      data: {
        project,
        marketplace,
        notes,
        owner: user.id,
        publishedAt: new Date(), // Manually set publishedAt if draft/publish is off
      },
    });

    console.log("entity",entity)

    const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitizedEntity);
  },

  async find(ctx) {
    const { user } = ctx.state;
    if (!user) {
      return ctx.unauthorized('You must be logged in to view shortlist items.');
    }

    // Combine any existing filters from the query with our mandatory owner filter
    const filters = {
      ...(ctx.query.filters || {}),
      owner: {
        id: user.id,
      },
    };
    
    // Use the entityService to fetch matching entries
    const entries = await strapi.entityService.findMany('api::shortlist.shortlist', {
      ...ctx.query, // Pass along other query params like pagination, sort
      filters,      // Apply our combined filters
      populate: ctx.query.populate || ['project', 'marketplace'], // Ensure relations are populated
    });
    
    // Sanitize the output and transform it into the expected API response format
    const sanitizedEntries = await this.sanitizeOutput(entries, ctx);
    // We manually wrap in 'data' here because we are not calling a core action
    // that does it automatically. We are not handling pagination meta for simplicity.
    return this.transformResponse(sanitizedEntries);
  },

  async deleteByProjectAndMarketplace(ctx) {
    const { user } = ctx.state;
    const { projectId, marketplaceId } = ctx.params;

    if (!user) {
      return ctx.unauthorized('You must be logged in.');
    }

    const entity = await strapi.db.query('api::shortlist.shortlist').findOne({
      where: {
        project: projectId,
        marketplace: marketplaceId,
        owner: user.id,
      },
    });

    if (!entity) {
      return ctx.notFound("Shortlisted item not found.");
    }

    await strapi.service('api::shortlist.shortlist').delete(entity.id);

    return { message: 'Item removed from shortlist successfully.' };
  }
})); 