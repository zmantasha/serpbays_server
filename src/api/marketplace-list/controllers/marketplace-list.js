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

    // Check if a list with the same name (case-insensitive) already exists for this user
    const trimmedName = name.trim();
    const allUserLists = await strapi.db.query('api::marketplace-list.marketplace-list').findMany({
      where: {
        owner: user.id,
      },
    });

    const existingList = allUserLists.find(list => 
      list.name && list.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );

    if (existingList) {
      console.log('❌ Duplicate list found:', { 
        requestedName: trimmedName, 
        existingName: existingList.name,
        userId: user.id, 
        existingListId: existingList.id 
      });
      return ctx.badRequest(`A list with the name "${trimmedName}" already exists. Please choose a different name.`);
    }

    console.log('✅ Creating new list:', { name: name.trim(), userId: user.id, marketplaceCount: marketplaces.length });

    const entity = await strapi.service('api::marketplace-list.marketplace-list').create({
      data: {
        name: name.trim(),
        marketplaces,
        description: description || '',
        owner: user.id,
      },
    });

    console.log('✅ List created successfully:', { id: entity.id, name: entity.name });
    const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitizedEntity);
  },

  async find(ctx) {
    const { user } = ctx.state;

    console.log('📋 FIND request received for user:', user?.id);

    if (!user) {
      return ctx.unauthorized('You must be logged in to view lists.');
    }

    // Get all lists for the current user with populated marketplaces.
    // Pre-fix populated marketplaces with `true` (all columns), which
    // returned publisher_*_pricing intake prices, gsc_permission_level,
    // approvalStatus / blacklist_status / delistedReason / dataVersion,
    // and the lastAhrefs/Moz/Semrush refresh-/export-at timestamps via
    // every list response — Strapi's sanitizeOutput only strips the
    // schema-declared private attributes (publisher_name / publisher_email
    // / gsc_refresh_token). Narrowed to {id} only — the frontend uses the
    // populated list solely for `marketplaces.length` and
    // `marketplaces.map(m => m.id)`, so id is sufficient. Marketplace
    // details are fetched separately via /api/marketplaces (which has its
    // own sanitizePublisherData strip).
    const entities = await strapi.db.query('api::marketplace-list.marketplace-list').findMany({
      where: {
        owner: user.id,
      },
      populate: {
        marketplaces: { select: ['id'] },
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

    console.log('📋 FINDONE request received:', { id, userId: user?.id });

    if (!user) {
      console.log('❌ User not authenticated');
      return ctx.unauthorized('You must be logged in to view lists.');
    }

    // Same populate narrowing as find() — only the marketplace ids
    // reach the response; richer marketplace data goes through
    // /api/marketplaces which applies its own sanitizer.
    const numericId = parseInt(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('List not found');
    }
    const entity = await strapi.db.query('api::marketplace-list.marketplace-list').findOne({
      where: {
        id: numericId,
        owner: user.id,
      },
      populate: {
        marketplaces: { select: ['id'] },
      },
    });

    if (!entity) {
      return ctx.notFound('List not found');
    }

    const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitizedEntity);
  },

  async update(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;
    const { name, marketplaces, description } = ctx.request.body.data;

    // Pre-fix logged ctx.request.body.data (full update payload). Trimmed
    // to id + user.id only so logs don't carry rich-text list names or
    // free-form descriptions.
    strapi.log?.info?.(`[marketplace-list] update id=${id} user=${user?.id}`);

    if (!user) {
      console.log('❌ User not authenticated');
      return ctx.unauthorized('You must be logged in to update a list.');
    }

    // Check if list exists and belongs to user
    const existingList = await strapi.db.query('api::marketplace-list.marketplace-list').findOne({
      where: {
        id: parseInt(id),
        owner: user.id,
      },
    });

    console.log('📋 Existing list:', existingList);

    if (!existingList) {
      console.log('❌ List not found or permission denied');
      return ctx.notFound('List not found or you do not have permission to update it.');
    }

    try {
      // Build update data object for non-relation fields
      const updateData = {};
      
      if (name !== undefined) {
        updateData.name = name;
      }
      
      if (description !== undefined) {
        updateData.description = description;
      }

      console.log('📝 Update data (non-relations):', updateData);
      console.log('📝 Marketplaces to set:', marketplaces);

      // Update non-relation fields first
      if (Object.keys(updateData).length > 0) {
        await strapi.db.query('api::marketplace-list.marketplace-list').update({
          where: { id: parseInt(id) },
          data: updateData,
        });
      }

      // Handle marketplaces relation separately - use set to replace entire relation
      if (marketplaces !== undefined && Array.isArray(marketplaces)) {
        // Ensure all IDs are valid numbers
        const validMarketplaceIds = marketplaces
          .map(mId => parseInt(mId))
          .filter(mId => !isNaN(mId) && mId > 0);
        
        console.log('📝 Setting marketplaces relation:', {
          input: marketplaces,
          valid: validMarketplaceIds,
          count: validMarketplaceIds.length
        });
        
        // Use set to replace the entire relation with the new array
        // The frontend already merges existing + new IDs, so we just set it
        await strapi.db.query('api::marketplace-list.marketplace-list').update({
          where: { id: parseInt(id) },
          data: {
            marketplaces: {
              set: validMarketplaceIds.map(mId => ({ id: mId })),
            },
          },
        });
        
        console.log('✅ Marketplaces relation updated with', validMarketplaceIds.length, 'items');
      }

      // Fetch the updated entity with id-only marketplace populate (see
      // find() comment — frontend only needs ids).
      const entity = await strapi.db.query('api::marketplace-list.marketplace-list').findOne({
        where: {
          id: parseInt(id),
        },
        populate: {
          marketplaces: { select: ['id'] },
        },
      });

      if (!entity) {
        console.log('❌ Entity not found after update');
        return ctx.notFound('List not found after update');
      }

      console.log('✅ List updated successfully:', { 
        id: entity.id, 
        name: entity.name, 
        marketplacesCount: entity.marketplaces?.length || 0,
        marketplaceIds: entity.marketplaces?.map(m => m.id) || []
      });
      const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
      return this.transformResponse(sanitizedEntity);
    } catch (error) {
      strapi.log?.error?.('[marketplace-list] update failed', { error: error.message });
      // Do NOT include error.message in the response — Strapi-internal
      // errors (DB constraint violations, etc.) would leak schema details.
      return ctx.internalServerError('Failed to update list');
    }
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

