'use strict';

/**
 * order-content controller.
 *
 * SECURITY NOTE — find / findOne overrides:
 *   The `Authenticated` role in the users-permissions plugin is granted
 *   `api::order-content.order-content.find` (and would, if toggled,
 *   findOne). Strapi's default core `find` controller applies NO row-level
 *   ownership filter; with the permission alone, any logged-in user could
 *   list ALL order-content rows on the platform. We override here so the
 *   controller itself enforces ownership regardless of which role flags
 *   are set. Update + create also stay overridden (ownership-checked).
 *   Delete intentionally NOT exposed to the Authenticated role.
 */

const { createCoreController } = require('@strapi/strapi').factories;

// Public-safe scalar fields. Future schema additions are NOT auto-exposed;
// they must be explicitly added here.
const ORDER_CONTENT_PUBLIC_FIELDS = [
  'id', 'documentId',
  'title', 'content', 'url',
  'metaDescription', 'keywords',
  'anchorText', 'links', 'minWordCount',
  'createdAt', 'updatedAt', 'publishedAt',
];

function buildOwnershipFilter(user) {
  if (!user || typeof user.id !== 'number') return null;
  const clauses = [
    { order: { advertiser: user.id } },
    { order: { publisher: user.id } },
  ];
  // Snapshot fallback for legacy orders (publisher FK never set, only
  // websitePublisherEmail captured at order-create time).
  if (user.email) {
    clauses.push({ order: { websitePublisherEmail: user.email } });
  }
  return { $or: clauses };
}

module.exports = createCoreController('api::order-content.order-content', ({ strapi }) => ({
  async find(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized('You must be logged in to list order content');
    }
    const ownership = buildOwnershipFilter(ctx.state.user);
    if (!ownership) {
      return ctx.unauthorized('Authenticated user missing identity');
    }
    // Merge ownership with any caller-supplied filters under $and so a
    // hostile caller can't widen scope past their own orders.
    const userFilters = ctx.query?.filters;
    ctx.query = {
      ...ctx.query,
      filters: userFilters ? { $and: [userFilters, ownership] } : ownership,
      fields: ORDER_CONTENT_PUBLIC_FIELDS,
      // No populate — relations (order/advertiser/publisher) carry PII.
      populate: undefined,
    };
    return await super.find(ctx);
  },

  async findOne(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized('You must be logged in to view order content');
    }
    const { id } = ctx.params;
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('Order content not found');
    }

    const row = await strapi.db.query('api::order-content.order-content').findOne({
      where: { id: numericId },
      populate: {
        order: {
          populate: {
            advertiser: { select: ['id'] },
            publisher:  { select: ['id'] },
          },
        },
      },
    });

    if (!row) return ctx.notFound('Order content not found');

    const user = ctx.state.user;
    const order = row.order;
    const isOwner =
      (order?.advertiser?.id === user.id) ||
      (order?.publisher?.id === user.id) ||
      (!order?.publisher?.id
        && order?.websitePublisherEmail
        && user.email
        && order.websitePublisherEmail === user.email);

    if (!isOwner) {
      // 404 — never differentiate "exists but not yours" from "doesn't
      // exist", or callers can enumerate order-content IDs.
      return ctx.notFound('Order content not found');
    }

    // Return ONLY allow-listed scalar fields. Drop the order relation
    // (which we populated solely for the ownership check).
    const safe = {};
    for (const k of ORDER_CONTENT_PUBLIC_FIELDS) {
      if (row[k] !== undefined) safe[k] = row[k];
    }
    return safe;
  },

  async create(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to create order content');
      }

      const { order: orderId, ...data } = ctx.request.body.data || ctx.request.body;

      if (orderId) {
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['advertiser'],
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        if (order.advertiser.id !== ctx.state.user.id) {
          return ctx.forbidden('You can only create content for your own orders');
        }
      }

      const entity = await strapi.entityService.create('api::order-content.order-content', {
        data: {
          ...data,
          order: orderId,
        },
      });

      return entity;
    } catch (error) {
      return ctx.badRequest('Failed to create order content', { error: error.message });
    }
  },

  async update(ctx) {
    try {
      const { id } = ctx.params;

      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to update order content');
      }

      const existingContent = await strapi.entityService.findOne('api::order-content.order-content', id, {
        populate: ['order.advertiser'],
      });

      if (!existingContent) {
        return ctx.notFound('Order content not found');
      }

      if (existingContent.order?.advertiser?.id !== ctx.state.user.id) {
        return ctx.forbidden('You can only update content for your own orders');
      }

      const entity = await strapi.entityService.update('api::order-content.order-content', id, {
        data: ctx.request.body.data || ctx.request.body,
      });

      return entity;
    } catch (error) {
      return ctx.badRequest('Failed to update order content', { error: error.message });
    }
  },
}));
