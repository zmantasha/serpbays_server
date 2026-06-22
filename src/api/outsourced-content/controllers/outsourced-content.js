'use strict';

/**
 * outsourced-content controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

// ===== Default core-router gating =====
//
// routes/outsourced-content.js uses createCoreRouter('api::outsourced-content.outsourced-content').
// The Authenticated role has find / findOne / update / delete grants. Without
// controller overrides, default Strapi core controllers run — no row-level
// ownership filter. Any logged-in user could list / read / update / delete
// every outsourced-content row.
const OUTSOURCED_PUBLIC_FIELDS = [
  'id', 'documentId', 'links', 'instructions',
  'createdAt', 'updatedAt', 'publishedAt',
];

async function findOrderForOutsourced(outsourcedId) {
  // Fetch the parent order + party FKs and snapshot email so we can do
  // the ownership check.
  const row = await strapi.db.query('api::outsourced-content.outsourced-content').findOne({
    where: { id: outsourcedId },
    populate: {
      order: {
        populate: {
          advertiser: { select: ['id'] },
          publisher:  { select: ['id'] },
        },
      },
    },
  });
  return row;
}

function isPartyToOrder(order, user) {
  if (!order || !user) return false;
  if (order.advertiser?.id === user.id) return true;
  if (order.publisher?.id === user.id) return true;
  if (!order.publisher?.id
      && order.websitePublisherEmail
      && user.email
      && order.websitePublisherEmail === user.email) {
    return true;
  }
  return false;
}

module.exports = createCoreController('api::outsourced-content.outsourced-content', ({ strapi }) => ({

  async find(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized('You must be logged in to list outsourced content');
    }
    const u = ctx.state.user;
    const ownership = {
      $or: [
        { order: { advertiser: u.id } },
        { order: { publisher: u.id } },
        ...(u.email ? [{ order: { websitePublisherEmail: u.email } }] : []),
      ],
    };
    const userFilters = ctx.query?.filters;
    ctx.query = {
      ...ctx.query,
      filters: userFilters ? { $and: [userFilters, ownership] } : ownership,
      fields: OUTSOURCED_PUBLIC_FIELDS,
      populate: undefined,
    };
    return super.find(ctx);
  },

  async findOne(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized('You must be logged in to view outsourced content');
    }
    const { id } = ctx.params;
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('Outsourced content not found');
    }
    const row = await findOrderForOutsourced(numericId);
    if (!row) return ctx.notFound('Outsourced content not found');
    if (!isPartyToOrder(row.order, ctx.state.user)) {
      return ctx.notFound('Outsourced content not found');
    }
    const safe = {};
    for (const k of OUTSOURCED_PUBLIC_FIELDS) {
      if (row[k] !== undefined) safe[k] = row[k];
    }
    return { data: safe };
  },

  async update(ctx) {
    if (!ctx.state.user) {
      return ctx.unauthorized();
    }
    const { id } = ctx.params;
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return ctx.notFound('Outsourced content not found');
    }
    const existing = await findOrderForOutsourced(numericId);
    if (!existing) return ctx.notFound('Outsourced content not found');
    // Only advertisers may edit their own outsourced-content rows.
    if (existing.order?.advertiser?.id !== ctx.state.user.id) {
      return ctx.notFound('Outsourced content not found');
    }
    const body = ctx.request.body?.data || ctx.request.body || {};
    const allowed = {};
    if (typeof body.instructions === 'string') allowed.instructions = body.instructions;
    if (body.links !== undefined) {
      allowed.links = typeof body.links === 'string' ? body.links : JSON.stringify(body.links);
    }
    if (Object.keys(allowed).length === 0) {
      return ctx.badRequest('No mutable fields supplied');
    }
    const updated = await strapi.entityService.update(
      'api::outsourced-content.outsourced-content',
      numericId,
      { data: allowed }
    );
    const safe = {};
    for (const k of OUTSOURCED_PUBLIC_FIELDS) {
      if (updated[k] !== undefined) safe[k] = updated[k];
    }
    return { data: safe };
  },

  async delete(ctx) {
    return ctx.forbidden('Outsourced content cannot be deleted');
  },

  // Custom create method
  async create(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to create outsourced content');
      }
      
      // Get data from request
      const { order, links, instructions } = ctx.request.body.data || ctx.request.body;
      
      if (!order ) {
        return ctx.badRequest('Missing required fields: order are required');
      }
      console.log("order",order)
      
      // Create the outsourced content entry
      const outsourcedContent = await strapi.entityService.create('api::outsourced-content.outsourced-content', {
        data: {
          links: typeof links === 'string' ? links : JSON.stringify(links),
          instructions,
          order,
          publishedAt: new Date()
        }
      });
      
      return { data: outsourcedContent };
    } catch (error) {
      console.error('Error creating outsourced content:', error);
      ctx.throw(500, error);
    }
  },
  
  // Fetch related outsourced content for an order
  async findByOrder(ctx) {
    try {
      const { id } = ctx.params;
      
      if (!id) {
        return ctx.badRequest('Order ID is required');
      }
      
      const outsourcedContent = await strapi.db.query('api::outsourced-content.outsourced-content').findOne({
        where: { order: id },
        populate: ['order']
      });
      
      if (!outsourcedContent) {
        return { data: null };
      }
      
      return { data: outsourcedContent };
    } catch (error) {
      console.error('Error finding outsourced content by order:', error);
      ctx.throw(500, error);
    }
  }
})); 