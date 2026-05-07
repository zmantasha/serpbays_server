'use strict';

/**
 * Admin controller for admin panel authentication and management
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('plugin::users-permissions.user', ({ strapi }) => ({

  /**
   * Admin login with enhanced security checks
   */
  async adminLogin(ctx) {
    try {
      const { identifier, password } = ctx.request.body;

      if (!identifier || !password) {
        return ctx.badRequest('Email and password are required');
      }

      // Use Strapi's auth service with better error handling
      let user, jwt;

      try {
        // Try to use the users-permissions plugin auth service
        if (strapi.plugins['users-permissions']?.services?.auth) {
          const result = await strapi.plugins['users-permissions'].services.auth.login({
            identifier,
            password,
            provider: 'local'
          });
          user = result.user;
          jwt = result.jwt;
        } else {
          // Fallback: manually verify credentials with proper password validation
          const foundUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: {
              $or: [
                { email: identifier },
                { username: identifier }
              ]
            },
            populate: ['role']
          });

          if (!foundUser) {
            console.log(`[ADMIN LOGIN FAILED] User not found: ${identifier}`);
            return ctx.badRequest('Invalid credentials');
          }

          // Properly validate password using Strapi's password service
          const isValidPassword = await strapi.plugins['users-permissions'].services.user.validatePassword(
            password,
            foundUser.password
          );

          if (!isValidPassword) {
            console.log(`[ADMIN LOGIN FAILED] Invalid password for user: ${identifier}`);
            return ctx.badRequest('Invalid credentials');
          }

          user = foundUser;
          jwt = strapi.plugins['users-permissions'].services.jwt.issue({
            id: user.id
          });
        }
      } catch (authError) {
        console.error('[ADMIN LOGIN AUTH ERROR]', authError);
        return ctx.badRequest('Invalid credentials');
      }

      // Check if user has admin privileges
      const userWithRole = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        user.id,
        { populate: ['role'] }
      );

      // Check if user has proper admin role
      const allowedAdminTypes = ['super_admin', 'admin', 'moderator'];
      const isAdmin = userWithRole.role?.type && allowedAdminTypes.includes(userWithRole.role.type);

      if (!isAdmin) {
        console.log(`[ADMIN LOGIN DENIED] User ${user.id} (${user.email}) denied admin login - Role: '${userWithRole.role?.type}' (${userWithRole.role?.name})`);
        return ctx.forbidden('Access denied. Admin privileges required.');
      }

      // Log successful admin login
      console.log(`[ADMIN LOGIN] Admin user ${user.id} (${user.email}) logged in`);

      // Return admin user data
      ctx.send({
        jwt,
        user: {
          id: userWithRole.id,
          username: userWithRole.username,
          email: userWithRole.email,
          role: userWithRole.role,
          confirmed: userWithRole.confirmed,
          blocked: userWithRole.blocked,
          createdAt: userWithRole.createdAt,
          updatedAt: userWithRole.updatedAt
        }
      });

    } catch (error) {
      console.error('[ADMIN LOGIN ERROR]', error);
      return ctx.badRequest('Invalid credentials or server error');
    }
  },

  /**
   * Get current admin user info
   */
  async me(ctx) {
    try {
      const userId = ctx.state.user.id;

      const user = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        userId,
        {
          populate: ['role', 'user_wallet']
        }
      );

      ctx.send({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        confirmed: user.confirmed,
        blocked: user.blocked,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        wallet: user.user_wallet
      });

    } catch (error) {
      console.error('[ADMIN ME ERROR]', error);
      return ctx.internalServerError('Failed to fetch admin user data');
    }
  },

  /**
   * Get admin dashboard statistics
   */
  async getDashboardStats(ctx) {
    try {
      const stats = {};

      // Get user statistics
      const totalUsers = await strapi.db.query('plugin::users-permissions.user').count();
      const activeUsers = await strapi.db.query('plugin::users-permissions.user').count({
        where: { confirmed: true, blocked: false }
      });
      const blockedUsers = await strapi.db.query('plugin::users-permissions.user').count({
        where: { blocked: true }
      });
      const pendingUsers = await strapi.db.query('plugin::users-permissions.user').count({
        where: { confirmed: false }
      });

      console.log('[DASHBOARD STATS] User counts:', { totalUsers, activeUsers, blockedUsers, pendingUsers });

      stats.users = {
        total: totalUsers,
        active: activeUsers,
        blocked: blockedUsers,
        pending: pendingUsers
      };

      // Get order statistics - wrapped in try-catch to prevent 500 error
      try {
        const totalOrders = await strapi.db.query('api::order.order').count();
        const pendingOrders = await strapi.db.query('api::order.order').count({
          where: { orderStatus: 'pending' }
        });
        const completedOrders = await strapi.db.query('api::order.order').count({
          where: { orderStatus: 'completed' }
        });

        stats.orders = {
          total: totalOrders,
          pending: pendingOrders,
          completed: completedOrders
        };
        console.log('[DASHBOARD] Orders query OK');
      } catch (ordersError) {
        console.error('[DASHBOARD ERROR] Orders query failed:', ordersError.message);
        stats.orders = {
          total: 0,
          pending: 0,
          completed: 0
        };
      }

      // Get financial statistics - wrapped in try-catch
      try {
        // Revenue = sum of successful inflow transactions (payments + deposits).
        // transactionStatus enum has no 'completed' value — valid success states are
        // 'success' and 'paid'. We exclude withdrawals/refunds/fees so this represents
        // money coming in, not flowing out.
        const successStatuses = ['success', 'paid'];
        const revenueTypes = ['payment', 'deposit'];

        const revenueData = await strapi.db.query('api::transaction.transaction').findMany({
          where: {
            transactionStatus: { $in: successStatuses },
            type: { $in: revenueTypes }
          },
          select: ['amount']
        });
        const totalRevenue = revenueData.reduce((sum, transaction) => {
          return sum + parseFloat(transaction.amount || 0);
        }, 0);

        // Count only the transactions that contributed to revenue so the
        // "X transactions" sub-label on the Revenue card stays consistent.
        const totalTransactions = revenueData.length;

        // Withdrawal-request schema field is `withdrawal_status`, not `status`.
        const pendingWithdrawals = await strapi.db.query('api::withdrawal-request.withdrawal-request').count({
          where: { withdrawal_status: 'pending' }
        });

        stats.financial = {
          totalTransactions,
          pendingWithdrawals,
          totalRevenue: totalRevenue.toFixed(2)
        };
        console.log('[DASHBOARD] Financial query OK');
      } catch (financialError) {
        console.error('[DASHBOARD ERROR] Financial query failed:', financialError.message);
        stats.financial = {
          totalTransactions: 0,
          pendingWithdrawals: 0,
          totalRevenue: '0.00'
        };
      }

      // Get website statistics - wrapped in try-catch
      try {
        const totalWebsites = await strapi.db.query('api::marketplace.marketplace').count();
        const approvedWebsites = await strapi.db.query('api::publisher-website.publisher-website').count({
          where: { submissionStatus: 'approved' }
        });

        stats.websites = {
          total: totalWebsites,
          approved: approvedWebsites
        };
        console.log('[DASHBOARD] Websites query OK');
      } catch (websitesError) {
        console.error('[DASHBOARD ERROR] Websites query failed:', websitesError.message);
        stats.websites = {
          total: 0,
          approved: 0
        };
      }

      // Get communication statistics
      const totalCommunications = await strapi.db.query('api::communication.communication').count();

      stats.communications = {
        total: totalCommunications
      };

      console.log('[DASHBOARD STATS] Final stats:', JSON.stringify(stats, null, 2));

      ctx.send(stats);

    } catch (error) {
      console.error('[ADMIN STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch dashboard statistics');
    }
  },

  /**
   * Get recent admin activities for dashboard
   */
  async getRecentActivities(ctx) {
    try {
      const activities = [];

      // Get recent users (last 10)
      const recentUsers = await strapi.db.query('plugin::users-permissions.user').findMany({
        orderBy: { createdAt: 'desc' },
        limit: 5,
        select: ['id', 'username', 'email', 'createdAt']
      });

      recentUsers.forEach(user => {
        activities.push({
          type: 'user_registration',
          title: 'New User Registration',
          description: `${user.username} (${user.email}) registered`,
          timestamp: user.createdAt,
          entityId: user.id,
          entityType: 'user'
        });
      });

      // Get recent orders (last 10)
      const recentOrders = await strapi.db.query('api::order.order').findMany({
        orderBy: { createdAt: 'desc' },
        limit: 5,
        populate: ['advertiser'],
        select: ['id', 'totalAmount', 'orderStatus', 'createdAt']
      });

      recentOrders.forEach(order => {
        activities.push({
          type: 'order_created',
          title: 'New Order Created',
          description: `Order #${order.id} for $${order.totalAmount} by ${order.advertiser?.username || 'Unknown'}`,
          timestamp: order.createdAt,
          entityId: order.id,
          entityType: 'order'
        });
      });

      // Sort activities by timestamp
      activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      ctx.send(activities.slice(0, 10)); // Return top 10 recent activities

    } catch (error) {
      console.error('[ADMIN ACTIVITIES ERROR]', error);
      return ctx.internalServerError('Failed to fetch recent activities');
    }
  }

}));
