export default {
  async find(ctx) {
    try {
      const { user } = ctx.state;
      
      if (!user || !user.isAdmin) {
        return ctx.unauthorized('Not authorized to access this resource');
      }

      // Get all content entries
      const entries = await strapi.db.query('api::content.content').findMany({
        select: ['id', 'title', 'description', 'createdAt', 'status'],
        orderBy: { createdAt: 'desc' },
      });

      return {
        data: entries,
        meta: {
          count: entries.length
        }
      };
    } catch (error) {
      strapi.log.error('Error fetching content:', error);
      return ctx.internalServerError('An error occurred while fetching content');
    }
  },

  async findOne(ctx) {
    try {
      const { id } = ctx.params;
      const { user } = ctx.state;
      
      if (!user || !user.isAdmin) {
        return ctx.unauthorized('Not authorized to access this resource');
      }

      const entry = await strapi.db.query('api::content.content').findOne({
        where: { id },
        select: ['id', 'title', 'description', 'createdAt', 'status'],
      });

      if (!entry) {
        return ctx.notFound('Content not found');
      }

      return {
        data: entry
      };
    } catch (error) {
      strapi.log.error('Error fetching content:', error);
      return ctx.internalServerError('An error occurred while fetching content');
    }
  },

  async delete(ctx) {
    try {
      const { id } = ctx.params;
      const { user } = ctx.state;
      
      if (!user || !user.isAdmin) {
        return ctx.unauthorized('Not authorized to access this resource');
      }

      const entry = await strapi.db.query('api::content.content').delete({
        where: { id },
      });

      if (!entry) {
        return ctx.notFound('Content not found');
      }

      return {
        data: entry
      };
    } catch (error) {
      strapi.log.error('Error deleting content:', error);
      return ctx.internalServerError('An error occurred while deleting content');
    }
  },

  async update(ctx) {
    try {
      const { id } = ctx.params;
      const { user } = ctx.state;
      const { title, description, status } = ctx.request.body;
      
      if (!user || !user.isAdmin) {
        return ctx.unauthorized('Not authorized to access this resource');
      }

      const entry = await strapi.db.query('api::content.content').update({
        where: { id },
        data: {
          title,
          description,
          status,
          updatedBy: user.id,
        },
      });

      if (!entry) {
        return ctx.notFound('Content not found');
      }

      return {
        data: entry
      };
    } catch (error) {
      strapi.log.error('Error updating content:', error);
      return ctx.internalServerError('An error occurred while updating content');
    }
  },

  async create(ctx) {
    try {
      const { user } = ctx.state;
      const { title, description, status } = ctx.request.body;
      
      if (!user || !user.isAdmin) {
        return ctx.unauthorized('Not authorized to access this resource');
      }

      const entry = await strapi.db.query('api::content.content').create({
        data: {
          title,
          description,
          status,
          createdBy: user.id,
          updatedBy: user.id,
        },
      });

      return {
        data: entry
      };
    } catch (error) {
      strapi.log.error('Error creating content:', error);
      return ctx.internalServerError('An error occurred while creating content');
    }
  }
}; 