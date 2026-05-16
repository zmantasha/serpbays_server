'use strict';

/**
 * shortlist controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::shortlist.shortlist', ({ strapi }) => ({
  async create(ctx) {
    const { user } = ctx.state;
    const { marketplace } = ctx.request.body.data;
    console.log("marketplace", marketplace)
    if (!user) {
      return ctx.unauthorized('You must be logged in to create a shortlist item.');
    }

    if (!marketplace) {
      return ctx.badRequest('Project and Marketplace are required.');
    }

    // Check if item already exists
    const existing = await strapi.db.query('api::shortlist.shortlist').findOne({
      where: {
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
        marketplace,
        owner: user.id,
        publishedAt: new Date(), // Manually set publishedAt if draft/publish is off
      },
    });

    console.log("entity", entity)

    // ========== AUTOSEND: ADD TO FAVORITE REMINDER LIST ==========
    try {
      const favoriteListId = process.env.AUTOSEND_FAVORITE_REMINDER_LIST_ID;
      if (favoriteListId && user.email) {
        const autoSendService = strapi.service('api::global.autosend-service');
        if (autoSendService) {
          autoSendService.addToList({ email: user.email, listId: favoriteListId })
            .catch(err => console.error('[Shortlist] AutoSend addToList error:', err.message));
          console.log(`[Shortlist] Added ${user.email} to favorite reminder list`);
        }
      }
    } catch (autoSendErr) {
      console.error('[Shortlist] AutoSend sync error (non-blocking):', autoSendErr.message);
    }
    // ========== END AUTOSEND ==========

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
      populate: ctx.query.populate || ['marketplace'], // Ensure relations are populated
    });

    // Sanitize the output and transform it into the expected API response format
    const sanitizedEntries = await this.sanitizeOutput(entries, ctx);
    // We manually wrap in 'data' here because we are not calling a core action
    // that does it automatically. We are not handling pagination meta for simplicity.
    return this.transformResponse(sanitizedEntries);
  },

  async delete(ctx) {
    const { user } = ctx.state;
    const { id } = ctx.params;
    console.log("user", user)
    console.log("id", id)

    if (!user) {
      return ctx.unauthorized('You must be logged in.');
    }

    // Find the shortlist item and verify ownership
    const entity = await strapi.db.query('api::shortlist.shortlist').findOne({
      where: {
        id: id,
        owner: user.id,
      },
    });

    if (!entity) {
      return ctx.notFound('Shortlist item not found or you do not have permission to delete it.');
    }

    // Delete the item
    await strapi.entityService.delete('api::shortlist.shortlist', entity.id);

    // ========== AUTOSEND: REMOVE FROM FAVORITE REMINDER LIST IF NO FAVORITES LEFT ==========
    try {
      const favoriteListId = process.env.AUTOSEND_FAVORITE_REMINDER_LIST_ID;
      if (favoriteListId && user.email) {
        // Check if user has any remaining shortlisted items
        const remainingCount = await strapi.db.query('api::shortlist.shortlist').count({
          where: { owner: user.id },
        });

        if (remainingCount === 0) {
          const autoSendService = strapi.service('api::global.autosend-service');
          if (autoSendService) {
            autoSendService.removeFromList({ email: user.email, listId: favoriteListId })
              .catch(err => console.error('[Shortlist] AutoSend removeFromList error:', err.message));
            console.log(`[Shortlist] Removed ${user.email} from favorite reminder list (no favorites left)`);
          }
        }
      }
    } catch (autoSendErr) {
      console.error('[Shortlist] AutoSend sync error (non-blocking):', autoSendErr.message);
    }
    // ========== END AUTOSEND ==========

    return { message: 'Item removed from shortlist successfully.' };
  }
}));
