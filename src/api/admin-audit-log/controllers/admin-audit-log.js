'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::admin-audit-log.admin-audit-log', ({ strapi }) => ({
  // Get audit logs with filtering
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

      const logs = await strapi.db.query('api::admin-audit-log.admin-audit-log').findMany({
        where: filters,
        orderBy: { createdAt: 'DESC' },
        limit: pageSize,
        offset: (page - 1) * pageSize,
        populate: ['adminUser', 'targetUser']
      });

      const total = await strapi.db.query('api::admin-audit-log.admin-audit-log').count({
        where: filters
      });

      ctx.body = {
        data: logs,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount: Math.ceil(total / pageSize),
            total: total
          }
        }
      };

    } catch (error) {
      console.error('Get audit logs error:', error);
      ctx.internalServerError('Failed to fetch audit logs');
    }
  }
}));
