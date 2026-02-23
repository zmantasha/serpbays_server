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

      // Role filter - use case-insensitive matching
      if (role) {
        filters.role = { name: { $containsi: role } };
      }

      // Status filter - convert status string to blocked/confirmed fields
      if (status) {
        switch (status.toLowerCase()) {
          case 'blocked':
            filters.blocked = true;
            break;
          case 'active':
            filters.blocked = false;
            filters.confirmed = true;
            break;
          case 'pending':
            filters.confirmed = false;
            filters.blocked = false;
            break;
        }
      }

      // Direct blocked/confirmed filters (for backwards compatibility)
      if (blocked !== '' && !status) {
        filters.blocked = blocked === 'true';
      }

      if (confirmed !== '' && !status) {
        filters.confirmed = confirmed === 'true';
      }

      // Get users with pagination - use start/limit for Strapi entityService
      const pageNum = parseInt(page);
      const pageSizeNum = parseInt(pageSize);
      const users = await strapi.entityService.findMany('plugin::users-permissions.user', {
        filters,
        sort,
        start: (pageNum - 1) * pageSizeNum,
        limit: pageSizeNum,
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
            page: pageNum,
            pageSize: pageSizeNum,
            pageCount: Math.ceil(total / pageSizeNum),
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

      // Get current user email before update (for cascading email changes)
      let oldEmail = null;
      if (updateData.email) {
        const existingUser = await strapi.entityService.findOne('plugin::users-permissions.user', id);
        oldEmail = existingUser?.email;
      }

      const updatedUser = await strapi.entityService.update('plugin::users-permissions.user', id, {
        data: updateData,
        populate: ['role', 'user_wallet']
      });

      // If email changed, cascade update to all publisher websites
      if (updateData.email && oldEmail && oldEmail !== updateData.email) {
        console.log(`[ADMIN ACTION] Email changed from ${oldEmail} to ${updateData.email} - cascading to publisher websites`);

        // Update publisher_email on marketplace listings owned by this user (by publisher relation)
        const updatedListings = await strapi.db.query('api::marketplace.marketplace').updateMany({
          where: { publisher: id },
          data: { publisher_email: updateData.email },
        });
        console.log(`[ADMIN ACTION] Updated publisher_email on ${updatedListings?.count || 0} marketplace listings (by publisher relation)`);

        // Also update legacy marketplace listings that match by old email (no publisher relation set)
        const updatedLegacyListings = await strapi.db.query('api::marketplace.marketplace').updateMany({
          where: { publisher_email: oldEmail },
          data: { publisher_email: updateData.email },
        });
        console.log(`[ADMIN ACTION] Updated publisher_email on ${updatedLegacyListings?.count || 0} marketplace listings (by email match)`);

        // Update publisher-website entries owned by this user (by currentPublisherId relation)
        const updatedWebsites = await strapi.db.query('api::publisher-website.publisher-website').updateMany({
          where: { currentPublisherId: id },
          data: { publisherEmail: updateData.email },
        });
        console.log(`[ADMIN ACTION] Updated publisherEmail on ${updatedWebsites?.count || 0} publisher-websites (by currentPublisherId relation)`);

        // Also update publisher-websites by originalPublisherId
        const updatedOriginalWebsites = await strapi.db.query('api::publisher-website.publisher-website').updateMany({
          where: { originalPublisherId: id },
          data: { publisherEmail: updateData.email },
        });
        console.log(`[ADMIN ACTION] Updated publisherEmail on ${updatedOriginalWebsites?.count || 0} publisher-websites (by originalPublisherId relation)`);

        // Also update any publisher-websites that match by old email (for legacy data)
        const updatedLegacyWebsites = await strapi.db.query('api::publisher-website.publisher-website').updateMany({
          where: { publisherEmail: oldEmail },
          data: { publisherEmail: updateData.email },
        });
        console.log(`[ADMIN ACTION] Updated publisherEmail on ${updatedLegacyWebsites?.count || 0} publisher-websites (by email match)`);
      }

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
