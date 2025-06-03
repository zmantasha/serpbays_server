'use strict';

module.exports = {
  async getDashboardStats(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in');
      }

      // Get total users count (excluding super admin)
      const usersCount = await strapi.query('plugin::users-permissions.user').count({
        where: {
          role: {
            type: {
              $ne: 'super-admin'
            }
          }
        }
      });

      // Get content count from collections that actually exist
      let contentCount = 0;
      const contentTypes = strapi.contentTypes;
      
      // Only count content from API content types (skip admin, plugins, etc)
      for (const key in contentTypes) {
        if (key.startsWith('api::')) {
          try {
            const count = await strapi.db.query(key).count();
            contentCount += count;
          } catch (err) {
            console.warn(`Could not count entries for ${key}:`, err.message);
          }
        }
      }

      return {
        data: {
          usersCount,
          contentCount,
          lastUpdated: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Dashboard stats error:', error);
      return ctx.throw(500, error);
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
        where: { 
          $or: [
            { email },
            { username }
          ]
        },
      });

      if (existingUser) {
        return ctx.badRequest(
          existingUser.email === email 
            ? 'Email already exists' 
            : 'Username already exists'
        );
      }

      // Get or create the admin role
      let adminRole = await strapi.query('plugin::users-permissions.role').findOne({
        where: { type: 'admin' },
      });

      if (!adminRole) {
        // Create the admin role if it doesn't exist
        adminRole = await strapi.query('plugin::users-permissions.role').create({
          data: {
            name: 'Admin',
            description: 'Administrator role with full access',
            type: 'admin',
          },
        });

        // Set up basic permissions for the admin role
        const permissionsToCreate = [
          { action: 'plugin::users-permissions.user.me' },
          { action: 'plugin::users-permissions.auth.callback' },
          { action: 'plugin::users-permissions.auth.connect' },
          { action: 'plugin::users-permissions.auth.register' },
          { action: 'api::admin.admin.signup' },
          { action: 'api::admin.admin.login' },
        ];

        for (const permission of permissionsToCreate) {
          await strapi.query('plugin::users-permissions.permission').create({
            data: {
              action: permission.action,
              role: adminRole.id,
            },
          });
        }

        console.log('Created new admin role with permissions:', adminRole);
      }

      if (!adminRole || !adminRole.id) {
        return ctx.badRequest('Failed to create or retrieve admin role');
      }

      // Create the admin user
      const user = await strapi.plugins['users-permissions'].services.user.add({
        email,
        username,
        password,
        role: adminRole.id,
        confirmed: true,
      });

      if (!user) {
        return ctx.badRequest('Failed to create user');
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
      console.error('Signup error:', error);
      return ctx.badRequest(error.message || 'An error occurred during signup');
    }
  },

  async login(ctx) {
    try {
      const { identifier, password } = ctx.request.body;

      if (!identifier || !password) {
        return ctx.badRequest('Please provide email and password');
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

      // Return sanitized user data
      return {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role.type,
        },
        jwt,
      };
    } catch (error) {
      console.error('Login error:', error);
      return ctx.badRequest(error.message || 'An error occurred during login');
    }
  },

  async me(ctx) {
    try {
      const { user } = ctx.state;

      if (!user) {
        return ctx.unauthorized('Not authenticated');
      }

      // Get fresh user data with role
      const userData = await strapi.query('plugin::users-permissions.user').findOne({
        where: { id: user.id },
        populate: ['role'],
      });

      if (!userData) {
        return ctx.notFound('User not found');
      }

      // Check if user is admin
      if (!userData.role || userData.role.type !== 'admin') {
        return ctx.unauthorized('Access denied. Admin only.');
      }

      // Return sanitized user data
      return {
        id: userData.id,
        username: userData.username,
        email: userData.email,
        role: userData.role.type,
      };
    } catch (error) {
      console.error('Error in me endpoint:', error);
      return ctx.internalServerError('An error occurred while fetching user data');
    }
  }
}; 