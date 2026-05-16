'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

const FIELDS = ['name', 'description', 'visibleColumns', 'allowSearch', 'allowFilter', 'allowDownload', 'currency'];

module.exports = createCoreController('api::shared-list-template.shared-list-template', ({ strapi }) => ({

  async find(ctx) {
    const data = await strapi.entityService.findMany('api::shared-list-template.shared-list-template', {
      sort: { createdAt: 'desc' },
      pageSize: 100,
    });
    ctx.send({ data });
  },

  async create(ctx) {
    const adminId = ctx.state.user?.id;
    const body = ctx.request.body?.data || ctx.request.body || {};
    if (!body.name || !String(body.name).trim()) {
      return ctx.badRequest('name is required');
    }
    if (!Array.isArray(body.visibleColumns) || body.visibleColumns.length === 0) {
      return ctx.badRequest('visibleColumns must be a non-empty array');
    }
    const data = {};
    for (const k of FIELDS) if (body[k] !== undefined) data[k] = body[k];
    data.createdByAdminId = adminId;
    const created = await strapi.entityService.create('api::shared-list-template.shared-list-template', { data });
    console.log(`[ADMIN ACTION] Admin ${adminId} created shared-list-template ${created.id} (${created.name})`);
    ctx.send({ data: created });
  },

  async delete(ctx) {
    const adminId = ctx.state.user?.id;
    const { id } = ctx.params;
    await strapi.entityService.delete('api::shared-list-template.shared-list-template', id);
    console.log(`[ADMIN ACTION] Admin ${adminId} deleted shared-list-template ${id}`);
    ctx.send({ data: { id } });
  },

}));
