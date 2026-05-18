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

      // Batch-compute lifetime deposits for the current page in one go, so
      // the admin UI can tell whether each user has crossed the deposit gate
      // without manual unlock. One SUM-grouped query — not N round trips.
      const minDepositRequired = (() => {
        const v = parseFloat(process.env.MARKETPLACE_UNLOCK_MIN_USD || '10');
        return Number.isFinite(v) && v > 0 ? v : 10;
      })();
      const userIds = users.map((u) => u.id);
      const depositsByUser = new Map();
      if (userIds.length > 0) {
        const depositRows = await strapi.db
          .query('api::transaction.transaction')
          .findMany({
            where: {
              users_permissions_user: { $in: userIds },
              type: 'deposit',
              transactionStatus: { $in: ['success', 'paid'] },
            },
            populate: { users_permissions_user: { fields: ['id'] } },
            select: ['amount'],
          });
        for (const row of depositRows) {
          const uid = row.users_permissions_user?.id;
          if (!uid) continue;
          depositsByUser.set(
            uid,
            (depositsByUser.get(uid) || 0) + parseFloat(row.amount || 0)
          );
        }
      }

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
        marketplaceUnlocked: !!user.marketplaceUnlocked,
        marketplaceUnlockReason: user.marketplaceUnlockReason || null,
        lifetimeDeposits: depositsByUser.get(user.id) || 0,
        minDepositRequired,
        statistics: {
          // Populate uses { count: true }, so Strapi returns { count: N } here
          // — handle the array shape too in case the populate ever changes.
          totalOrders:
            (user.advertiserOrders?.count ?? user.advertiserOrders?.length ?? 0) +
            (user.publisherOrders?.count ?? user.publisherOrders?.length ?? 0),
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

      // Marketplace gate context: sum of settled deposit transactions vs. the
      // env-configured threshold. The admin UI uses this to tell whether the
      // user has already crossed the gate via real deposits even when no
      // manual unlock has been applied. Keep these expressions in sync with
      // marketplace.js (getLifetimeDeposits + getMarketplaceUnlockMin).
      const minDepositRequired = (() => {
        const v = parseFloat(process.env.MARKETPLACE_UNLOCK_MIN_USD || '10');
        return Number.isFinite(v) && v > 0 ? v : 10;
      })();
      const depositRows = await strapi.db.query('api::transaction.transaction').findMany({
        where: {
          users_permissions_user: id,
          type: 'deposit',
          transactionStatus: { $in: ['success', 'paid'] },
        },
        select: ['amount'],
      });
      const lifetimeDeposits = depositRows.reduce(
        (s, r) => s + parseFloat(r.amount || 0),
        0
      );

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
        marketplaceUnlocked: !!user.marketplaceUnlocked,
        marketplaceUnlockedAt: user.marketplaceUnlockedAt || null,
        marketplaceUnlockedBy: user.marketplaceUnlockedBy || null,
        marketplaceUnlockReason: user.marketplaceUnlockReason || null,
        lifetimeDeposits,
        minDepositRequired,
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
   * Manually toggle marketplace gate for a user (super admin only).
   * Body: { unlocked: boolean, reason?: string }
   *  - unlocked=true → requires reason, sets the 4 audit fields with the
   *    acting admin's email and current timestamp captured server-side so
   *    the client can't spoof them.
   *  - unlocked=false → clears the 4 audit fields; the user falls back to
   *    the natural lifetime-deposits gate.
   */
  async marketplaceUnlock(ctx) {
    try {
      const { id } = ctx.params;
      const { unlocked, reason } = ctx.request.body || {};
      const adminEmail = ctx.state.user?.email || 'unknown';

      if (typeof unlocked !== 'boolean') {
        return ctx.badRequest('Field `unlocked` (boolean) is required.');
      }
      if (unlocked && (!reason || !String(reason).trim())) {
        return ctx.badRequest('Field `reason` is required when unlocking.');
      }

      const data = unlocked
        ? {
            marketplaceUnlocked: true,
            marketplaceUnlockedAt: new Date(),
            marketplaceUnlockedBy: adminEmail,
            marketplaceUnlockReason: String(reason).trim(),
          }
        : {
            marketplaceUnlocked: false,
            marketplaceUnlockedAt: null,
            marketplaceUnlockedBy: null,
            marketplaceUnlockReason: null,
          };

      console.log(
        `[ADMIN ACTION] ${adminEmail} ${unlocked ? 'unlocked' : 're-locked'} marketplace for user ${id}` +
          (unlocked ? ` — reason: ${data.marketplaceUnlockReason}` : '')
      );

      const updatedUser = await strapi.entityService.update(
        'plugin::users-permissions.user',
        id,
        { data, populate: ['role'] }
      );

      ctx.send({ data: updatedUser });
    } catch (error) {
      console.error('[ADMIN USER MARKETPLACE UNLOCK ERROR]', error);
      return ctx.internalServerError('Failed to update marketplace access');
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
  },

  /**
   * List projects owned by a given user (for admin-assisted order creation).
   * Read-only. Omits archived projects by default; pass includeArchived=true to include.
   */
  async getUserProjects(ctx) {
    try {
      const { id } = ctx.params;
      const { includeArchived } = ctx.query || {};
      const userId = parseInt(id, 10);
      if (Number.isNaN(userId)) {
        return ctx.badRequest('Invalid user id');
      }

      const where = { owner: userId };
      if (!includeArchived || includeArchived === 'false') {
        where.archived = { $ne: true };
      }

      const projects = await strapi.db.query('api::project.project').findMany({
        where,
        orderBy: { createdAt: 'DESC' },
        select: ['id', 'ProjectName', 'projectUrl', 'archived', 'status', 'createdAt']
      });

      ctx.send({ data: projects });
    } catch (error) {
      console.error('[ADMIN USER PROJECTS ERROR]', error);
      return ctx.internalServerError('Failed to fetch user projects');
    }
  }

}));
