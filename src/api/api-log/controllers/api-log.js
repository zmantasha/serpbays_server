'use strict';

/**
 * api-log controller
 *
 * Read-only access to the api_logs collection. The Winston DB transport
 * writes rows directly via strapi.db.query, bypassing this controller, so
 * create/update/delete are explicitly forbidden here as defense in depth.
 *
 * The route file additionally guards every endpoint with the existing
 * `global::is-super-admin` policy.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::api-log.api-log', ({ strapi }) => ({
  async find(ctx) {
    // Defense in depth: re-check role even though the route policy already gates this.
    if (!ctx.state.user || ctx.state.user.role?.type !== 'super_admin') {
      return ctx.forbidden('Only super admins may read API logs');
    }
    return await super.find(ctx);
  },

  async findOne(ctx) {
    if (!ctx.state.user || ctx.state.user.role?.type !== 'super_admin') {
      return ctx.forbidden('Only super admins may read API logs');
    }
    return await super.findOne(ctx);
  },

  async create(ctx) {
    return ctx.forbidden('API logs are written by the Winston DB transport only');
  },

  async update(ctx) {
    return ctx.forbidden('API logs are immutable');
  },

  async delete(ctx) {
    return ctx.forbidden('API logs are purged by the cron job only');
  },
}));
