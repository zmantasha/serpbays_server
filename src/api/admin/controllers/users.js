'use strict';

/**
 * Admin Users Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('plugin::users-permissions.user', ({ strapi }) => ({

  /**
   * Get all users with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const {
        page = 1,
        pageSize = 20,
        sort = 'createdAt:desc',
        search = '',
        role = '',
        status = '',
        blocked = '',
        confirmed = ''
      } = ctx.query;

      // Build filters
      const filters = {};

      // Search filter
      if (search) {
        filters.$or = [
          { username: { $containsi: search } },
          { email: { $containsi: search } },
          { firstName: { $containsi: search } },
          { lastName: { $containsi: search } }
        ];
      }

      // Role filter
      if (role) {
        filters.role = { name: role };
      }

      // Status filters
      if (blocked !== '') {
        filters.blocked = blocked === 'true';
      }

      if (confirmed !== '') {
        filters.confirmed = confirmed === 'true';
      }

      // Get users with pagination
      const users = await strapi.entityService.findMany('plugin::users-permissions.user', {
        filters,
        sort,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize)
        },
        populate: {
          role: true,
          user_wallet: true,
          advertiserOrders: {
            count: true
          },
          publisherOrders: {
            count: true
          },
          transactions: {
            count: true
          }
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('plugin::users-permissions.user').count({ where: filters });

      // Transform user data for admin panel
      const transformedUsers = users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: user.phoneNumber,
        confirmed: user.confirmed,
        blocked: user.blocked,
        provider: user.provider,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        role: user.role,
        profile: {
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phoneNumber,
          businessName: user.businessName,
          website: user.website,
          city: user.city,
          country: user.country
        },
        wallet: user.user_wallet ? {
          balance: parseFloat(user.user_wallet.balance || 0),
          currency: user.user_wallet.currency || 'USD'
        } : null,
        statistics: {
          totalOrders: (user.advertiserOrders?.length || 0) + (user.publisherOrders?.length || 0),
          totalSpent: 0, // Will be calculated separately if needed
          totalEarnings: 0, // Will be calculated separately if needed
          lastLogin: user.updatedAt, // Using updatedAt as proxy for last login
          joinDate: user.createdAt
        }
      }));

      ctx.send({
        data: transformedUsers,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount: Math.ceil(total / pageSize),
            total
          }
        }
      });

    } catch (error) {
      console.error('[ADMIN USERS FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch users');
    }
  },

  /**
   * Get single user with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;

      console.log('[USER DETAILS] Fetching user ID:', id);

      // Simplified populate to avoid 500 errors
      const user = await strapi.entityService.findOne('plugin::users-permissions.user', id, {
        populate: ['role', 'user_wallet']
      });

      if (!user) {
        console.log('[USER DETAILS] User not found:', id);
        return ctx.notFound('User not found');
      }

      console.log('[USER DETAILS] Successfully fetched user');

      const transformedUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: user.phoneNumber,
        confirmed: user.confirmed,
        blocked: user.blocked,
        provider: user.provider,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        Advertiser: user.Advertiser,
        Publisher: user.Publisher,
        businessName: user.businessName,
        billingAddress: user.billingAddress,
        city: user.city,
        country: user.country,
        website: user.website,
        role: user.role,
        profile: {
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phoneNumber,
          businessName: user.businessName,
          website: user.website,
          city: user.city,
          country: user.country,
          billingAddress: user.billingAddress
        },
        wallet: user.user_wallet ? {
          balance: parseFloat(user.user_wallet.balance || 0),
          escrowBalance: parseFloat(user.user_wallet.escrowBalance || 0),
          pendingWithdrawalBalance: parseFloat(user.user_wallet.pendingWithdrawalBalance || 0),
          currency: user.user_wallet.currency || 'USD'
        } : null,
        statistics: {
          totalOrders: 0,
          totalSpent: 0,
          totalEarnings: 0,
          lastLogin: user.updatedAt,
          joinDate: user.createdAt
        },
        recentOrders: [],
        recentTransactions: [],
        recentCommunications: [],
        withdrawalRequests: []
      };

      ctx.send({
        data: transformedUser
      });

    } catch (error) {
      console.error('[USER DETAILS ERROR] Message:', error.message);
      console.error('[USER DETAILS ERROR] Stack:', error.stack);
      return ctx.internalServerError('Failed to fetch user details');
    }
  },

  /**
   * Update user (admin can update any field)
   */
  async update(ctx) {
    try {
      const { id } = ctx.params;
      const updateData = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} updating user ${id}`);

      const updatedUser = await strapi.entityService.update('plugin::users-permissions.user', id, {
        data: updateData,
        populate: ['role', 'user_wallet']
      });

      ctx.send({
        data: updatedUser
      });

    } catch (error) {
      console.error('[ADMIN USER UPDATE ERROR]', error);
      return ctx.internalServerError('Failed to update user');
    }
  },

  /**
   * Block/Unblock user
   */
  async toggleBlock(ctx) {
    try {
      const { id } = ctx.params;
      const { blocked } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} ${blocked ? 'blocking' : 'unblocking'} user ${id}`);

      const updatedUser = await strapi.entityService.update('plugin::users-permissions.user', id, {
        data: { blocked: !!blocked },
        populate: ['role']
      });

      ctx.send({
        data: updatedUser
      });

    } catch (error) {
      console.error('[ADMIN USER TOGGLE BLOCK ERROR]', error);
      return ctx.internalServerError('Failed to update user status');
    }
  },

  /**
   * Confirm user email
   */
  async confirmUser(ctx) {
    try {
      const { id } = ctx.params;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} confirming user ${id}`);

      const updatedUser = await strapi.entityService.update('plugin::users-permissions.user', id, {
        data: { confirmed: true },
        populate: ['role']
      });

      ctx.send({
        data: updatedUser
      });

    } catch (error) {
      console.error('[ADMIN USER CONFIRM ERROR]', error);
      return ctx.internalServerError('Failed to confirm user');
    }
  },

  /**
   * Delete user
   */
  async delete(ctx) {
    try {
      const { id } = ctx.params;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} deleting user ${id}`);

      await strapi.entityService.delete('plugin::users-permissions.user', id);

      ctx.send({
        message: 'User deleted successfully'
      });

    } catch (error) {
      console.error('[ADMIN USER DELETE ERROR]', error);
      return ctx.internalServerError('Failed to delete user');
    }
  },

  /**
   * Get user statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      const total = await strapi.db.query('plugin::users-permissions.user').count();
      const active = await strapi.db.query('plugin::users-permissions.user').count({
        where: { confirmed: true, blocked: false }
      });
      const blocked = await strapi.db.query('plugin::users-permissions.user').count({
        where: { blocked: true }
      });
      const pending = await strapi.db.query('plugin::users-permissions.user').count({
        where: { confirmed: false }
      });

      // Get new users this month
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);

      const newThisMonth = await strapi.db.query('plugin::users-permissions.user').count({
        where: {
          createdAt: {
            $gte: thisMonth.toISOString()
          }
        }
      });

      // Get new users this week
      const thisWeek = new Date();
      thisWeek.setDate(thisWeek.getDate() - thisWeek.getDay());
      thisWeek.setHours(0, 0, 0, 0);

      const newThisWeek = await strapi.db.query('plugin::users-permissions.user').count({
        where: {
          createdAt: {
            $gte: thisWeek.toISOString()
          }
        }
      });

      ctx.send({
        total,
        active,
        blocked,
        pending,
        newThisMonth,
        newThisWeek
      });

    } catch (error) {
      console.error('[ADMIN USER STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch user statistics');
    }
  }

}));
