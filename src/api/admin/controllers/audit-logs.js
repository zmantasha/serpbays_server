'use strict';

/**
 * Admin Audit Logs Controller.
 * Wrapped with createCoreController so it's registered by Strapi's core loader
 * the same way every other admin/controllers/* file is.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::admin-audit-log.admin-audit-log', ({ strapi }) => ({
  async find(ctx) {
    try {
      const {
        page = 1,
        pageSize = 50,
        action,
        adminUser,
        targetUser,
        startDate,
        endDate
      } = ctx.query;

      const filters = {};
      if (action) filters.action = action;
      if (adminUser) filters.adminUser = adminUser;
      if (targetUser) filters.targetUser = targetUser;

      if (startDate || endDate) {
        filters.createdAt = {};
        if (startDate) filters.createdAt.$gte = new Date(startDate);
        if (endDate) filters.createdAt.$lte = new Date(endDate);
      }

      const pageNum = parseInt(page, 10) || 1;
      const size = Math.min(parseInt(pageSize, 10) || 50, 200);

      const [logs, total] = await Promise.all([
        strapi.db.query('api::admin-audit-log.admin-audit-log').findMany({
          where: filters,
          orderBy: { createdAt: 'DESC' },
          limit: size,
          offset: (pageNum - 1) * size,
          populate: ['adminUser', 'targetUser']
        }),
        strapi.db.query('api::admin-audit-log.admin-audit-log').count({ where: filters })
      ]);

      ctx.body = {
        data: logs,
        meta: {
          pagination: {
            page: pageNum,
            pageSize: size,
            pageCount: Math.ceil(total / size),
            total
          }
        }
      };
    } catch (error) {
      console.error('[ADMIN AUDIT LOG FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch audit logs');
    }
  }
}));
