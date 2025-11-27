'use strict';

/**
 * marketplace-list controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::marketplace-list.marketplace-list', ({ strapi }) => ({
  async create(ctx) {
    const { user } = ctx.state;
    const { name, marketplaces, description } = ctx.request.body.data;

    if (!user) {
      return ctx.unauthorized('You must be logged in to create a list.');
    }

    if (!name) {
      return ctx.badRequest('List name is required.');
    }

    if (!marketplaces || marketplaces.length === 0) {
      return ctx.badRequest('At least one marketplace item is required.');
    }

    const entity = await strapi.service('api::marketplace-list.marketplace-list').create({
      data: {
        name,
        marketplaces,
        description: description || '',
        owner: user.id,
      },
    });

    const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitizedEntity);
  },

  async find(ctx) {
    const { user } = ctx.state;

    console.log('📋 FIND request received for user:', user?.id);

    if (!user) {
      return ctx.unauthorized('You must be logged in to view lists.');
    }

    // Get all lists for the current user with populated marketplaces
    const entities = await strapi.db.query('api::marketplace-list.marketplace-list').findMany({
      where: {
        owner: user.id,
      },
      populate: {
        marketplaces: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    console.log('📋 Found lists:', entities.map(e => ({ id: e.id, name: e.name })));

    const sanitizedEntities = await this.sanitizeOutput(entities, ctx);
    return this.transformResponse(sanitizedEntities);
  },

  async findOne(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;

    if (!user) {
      return ctx.unauthorized('You must be logged in to view lists.');
    }

    const entity = await strapi.db.query('api::marketplace-list.marketplace-list').findOne({
      where: {
        id,
        owner: user.id,
      },
      populate: {
        marketplaces: true,
      },
    });

    if (!entity) {
      return ctx.notFound('List not found or you do not have permission to access it.');
    }

    const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitizedEntity);
  },

  async update(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;
    const { name, marketplaces, description } = ctx.request.body.data;

    if (!user) {
      return ctx.unauthorized('You must be logged in to update a list.');
    }

    // Check if list exists and belongs to user
    const existingList = await strapi.db.query('api::marketplace-list.marketplace-list').findOne({
      where: {
        id,
        owner: user.id,
      },
    });

    if (!existingList) {
      return ctx.notFound('List not found or you do not have permission to update it.');
    }

    const entity = await strapi.service('api::marketplace-list.marketplace-list').update(id, {
      data: {
        name: name || existingList.name,
        marketplaces: marketplaces !== undefined ? marketplaces : undefined,
        description: description !== undefined ? description : existingList.description,
      },
    });

    const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitizedEntity);
  },

  async delete(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;

    console.log('🗑️ DELETE request received:', { id, userId: user?.id });

    if (!user) {
      console.log('❌ User not authenticated');
      return ctx.unauthorized('You must be logged in to delete a list.');
    }

    // Check if list exists and belongs to user
    const existingList = await strapi.db.query('api::marketplace-list.marketplace-list').findOne({
      where: {
        id: parseInt(id),
        owner: user.id,
      },
    });

    console.log('📋 Existing list found:', existingList);

    if (!existingList) {
      console.log('❌ List not found or permission denied');
      return ctx.notFound('List not found or you do not have permission to delete it.');
    }

    try {
      // Delete using database query directly
      const result = await strapi.db.query('api::marketplace-list.marketplace-list').delete({
        where: {
          id: parseInt(id),
        },
      });
      
      console.log('✅ Delete result:', result);
      console.log('✅ List deleted successfully from database');
      
      return ctx.send({ 
        data: { 
          message: 'List deleted successfully',
          deletedId: parseInt(id)
        } 
      });
    } catch (error) {
      console.error('❌ Error deleting list:', error);
      return ctx.internalServerError('Failed to delete list');
    }
  },
}));

