'use strict';

/**
 * shortlist controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

// Marketplace fields that are safe to return inline alongside each
// shortlist row. Server-defined; caller-supplied `populate` is ignored.
//
// Pre-fix find() honored `ctx.query.populate || ['marketplace']`, so
// `?populate[marketplace][populate]=*` returned the full marketplace
// row PLUS the populated publisher user object — leaking publisher PII
// (email, clerkId, etc.), publisher_*_pricing intake prices,
// gsc_refresh_token, gsc_permission_level, and internal admin state
// to any authenticated user via this adjacent endpoint, bypassing the
// /api/marketplaces sanitizer entirely.
//
// This list mirrors the public subset of the marketplace controller's
// MARKETPLACE_PUBLIC_FIELDS. Duplicated here (rather than imported) so
// the two endpoints can diverge later without coupling. If the
// frontend ever needs richer marketplace data (publisher info on
// shortlists you own etc.), it should fetch /api/marketplaces/:id
// directly — that endpoint runs the proper ownership-aware sanitizer.
const SHORTLIST_MARKETPLACE_FIELDS = [
  // Identity
  'id', 'documentId', 'url',
  // Advertiser-facing pricing only (NEVER publisher intake prices)
  'price', 'link_insertion_price',
  'adv_casino_pricing', 'adv_cbd_pricing', 'adv_crypto_pricing', 'adv_dating_pricing',
  'adv_li_casino_pricing', 'adv_li_cbd_pricing', 'adv_li_crypto_pricing', 'adv_li_dating_pricing',
  // Site spec / content requirements
  'tat', 'placement_speed', 'min_word_count',
  'backlink_type', 'backlink_validity', 'dofollow_link',
  'category', 'other_category', 'language', 'countries',
  'guidelines', 'sample_post', 'sample_links',
  'description', 'publication_location', 'domain_zone',
  // Public SEO metrics
  'ahrefs_dr', 'ahrefs_traffic', 'ahrefs_rank', 'ahrefs_referring_domain', 'ahrefs_keywords',
  'moz_da', 'semrush_authority_score', 'semrush_traffic', 'spam_score', 'similarweb_traffic',
  // Trust + feature flags
  'gsc_verified',
  'sponsored', 'ugc', 'digital_pr', 'only_with_us', 'fast_placement_status',
  'isFeatured', 'isFeaturedGuestPost', 'isFeaturedLinkInsertion',
  'website_status', 'status',
  // Timestamps (marketplace draftAndPublish: false → no publishedAt)
  'createdAt', 'updatedAt',
];

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

  // Default core-router exposes GET /shortlists/:id and PUT /shortlists/:id.
  // Authenticated has findOne + update permission. Without overrides, the
  // default controllers would return / mutate any shortlist row across
  // tenants. Force ownership.
  async findOne(ctx) {
    const { user } = ctx.state;
    if (!user) return ctx.unauthorized();
    const numericId = Number(ctx.params.id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('Shortlist item not found');
    }
    const record = await strapi.db.query('api::shortlist.shortlist').findOne({
      where: { id: numericId },
      populate: { owner: { select: ['id'] } },
    });
    if (!record || record.owner?.id !== user.id) {
      return ctx.notFound('Shortlist item not found');
    }
    const sanitized = await this.sanitizeOutput(record, ctx);
    return this.transformResponse(sanitized);
  },

  async update(ctx) {
    // No legitimate use case for partial-update of a shortlist row from
    // the user side. Delete + re-add is the supported flow. Forbid here.
    return ctx.forbidden('Shortlist items cannot be modified; delete and re-add instead');
  },

  async find(ctx) {
    const { user } = ctx.state;
    if (!user) {
      return ctx.unauthorized('You must be logged in to view shortlist items.');
    }

    // Mandatory owner filter — combined with any caller-supplied filters.
    const filters = {
      ...(ctx.query.filters || {}),
      owner: {
        id: user.id,
      },
    };

    // Server-defined populate. Pre-fix this was
    //   `populate: ctx.query.populate || ['marketplace']`
    // which honored caller-controlled populate from the query string.
    // `?populate[marketplace][populate]=*` returned the FULL marketplace
    // row + populated publisher user object — leaking publisher PII,
    // intake pricing, gsc_refresh_token, and internal admin state via
    // every shortlist response. The marketplace controller's pass-5
    // sanitizer was bypassed because this endpoint went through
    // sanitizeOutput (schema-private only) instead.
    //
    // Now the populate spec is hardcoded and the caller's ?populate=
    // is ignored. Pagination and sort still flow through ctx.query
    // (explicitly forwarded, not spread, so populate cannot be smuggled
    // through other params).
    const entries = await strapi.entityService.findMany('api::shortlist.shortlist', {
      filters,
      pagination: ctx.query.pagination,
      sort: ctx.query.sort,
      populate: {
        marketplace: { fields: SHORTLIST_MARKETPLACE_FIELDS },
      },
    });

    const sanitizedEntries = await this.sanitizeOutput(entries, ctx);
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
