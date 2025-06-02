'use strict';

module.exports = {
  async getDashboardStats(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in');
      }

      const usersCount = await strapi.query('plugin::users-permissions.user').count();
      const contentCount = await strapi.query('api::content.content').count();
      
      // Add more statistics as needed
      const stats = {
        usersCount,
        contentCount,
        lastUpdated: new Date(),
      };

      return { data: stats };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async getUsers(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in');
      }

      const users = await strapi.query('plugin::users-permissions.user').findMany({
        select: ['id', 'username', 'email', 'createdAt', 'blocked'],
        populate: ['role'],
      });

      return { data: users };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async updateUser(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in');
      }

      const { id } = ctx.params;
      const { blocked, role } = ctx.request.body;

      const updatedUser = await strapi.query('plugin::users-permissions.user').update({
        where: { id },
        data: { blocked, role },
      });

      return { data: updatedUser };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async deleteUser(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in');
      }

      const { id } = ctx.params;

      // Prevent deleting self
      if (id === ctx.state.user.id) {
        return ctx.badRequest('You cannot delete your own account');
      }

      const deletedUser = await strapi.query('plugin::users-permissions.user').delete({
        where: { id },
      });

      return { data: deletedUser };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async getContent(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in');
      }

      const content = await strapi.query('api::content.content').findMany({
        populate: ['author'],
      });

      return { data: content };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async updateContent(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in');
      }

      const { id } = ctx.params;
      const updateData = ctx.request.body;

      const updatedContent = await strapi.query('api::content.content').update({
        where: { id },
        data: updateData,
      });

      return { data: updatedContent };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async deleteContent(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in');
      }

      const { id } = ctx.params;

      const deletedContent = await strapi.query('api::content.content').delete({
        where: { id },
      });

      return { data: deletedContent };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async signup(ctx) {
    try {
      const { email, username, password } = ctx.request.body;

      if (!email || !username || !password) {
        return ctx.badRequest('Please provide all required fields');
      }

      // Check if user already exists
      const existingUser = await strapi.query('plugin::users-permissions.user').findOne({
        where: { email },
      });

      if (existingUser) {
        return ctx.badRequest('Email already exists');
      }

      // Get the admin role
      const adminRole = await strapi.query('plugin::users-permissions.role').findOne({
        where: { type: 'admin' },
      });

      if (!adminRole) {
        return ctx.badRequest('Admin role not found');
      }

      // Create the admin user
      const user = await strapi.plugins['users-permissions'].services.user.add({
        email,
        username,
        password,
        role: adminRole.id,
        confirmed: true,
      });

      // Generate JWT token
      const jwt = strapi.plugins['users-permissions'].services.jwt.issue({
        id: user.id,
      });

      return {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: 'admin',
        },
        jwt,
      };
    } catch (error) {
      ctx.throw(500, error);
    }
  },

  async login(ctx) {
    try {
      const { identifier, password } = ctx.request.body;

      if (!identifier || !password) {
        return ctx.badRequest('Please provide identifier and password');
      }

      // Find the user
      const user = await strapi.query('plugin::users-permissions.user').findOne({
        where: {
          $or: [
            { email: identifier },
            { username: identifier },
          ],
        },
        populate: ['role'],
      });

      if (!user) {
        return ctx.badRequest('Invalid credentials');
      }

      // Check if user is admin
      if (!user.role || user.role.type !== 'admin') {
        return ctx.unauthorized('Access denied. Admin only.');
      }

      // Validate password
      const validPassword = await strapi.plugins['users-permissions'].services.user.validatePassword(
        password,
        user.password
      );

      if (!validPassword) {
        return ctx.badRequest('Invalid credentials');
      }

      // Generate JWT token
      const jwt = strapi.plugins['users-permissions'].services.jwt.issue({
        id: user.id,
      });

      return {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: 'admin',
        },
        jwt,
      };
    } catch (error) {
      ctx.throw(500, error);
    }
  },
}; 