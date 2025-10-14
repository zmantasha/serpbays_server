'use strict';

/**
 * Admin Wallet Management Controller
 */

module.exports = {

  /**
   * Get all users wallet information with pagination and filters
   */
  async getAllWallets(ctx) {
    try {
      const { page = 1, pageSize = 20, search, sortBy = 'createdAt', sortOrder = 'desc' } = ctx.query;

      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} fetching all wallets - Page: ${page}, Size: ${pageSize}`);

      // Build query filters
      const filters = {};
      
      if (search) {
        filters.$or = [
          { users_permissions_user: { username: { $containsi: search } } },
          { users_permissions_user: { email: { $containsi: search } } }
        ];
      }

      // Handle sorting - only allow sorting by wallet fields, not user fields
      const allowedSortFields = ['createdAt', 'updatedAt', 'balance', 'mainBalance', 'promoBalance', 'escrowBalance', 'pendingWithdrawalBalance'];
      const finalSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';

      // Get wallets with user information
      const wallets = await strapi.db.query('api::user-wallet.user-wallet').findMany({
        where: filters,
        populate: {
          users_permissions_user: {
            select: ['id', 'username', 'email', 'firstName', 'lastName', 'createdAt']
          }
        },
        orderBy: { [finalSortBy]: sortOrder },
        limit: parseInt(pageSize),
        offset: (parseInt(page) - 1) * parseInt(pageSize)
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::user-wallet.user-wallet').count({
        where: filters
      });

      // Transform data for frontend
      const transformedWallets = wallets.map(wallet => ({
        id: wallet.id,
        userId: wallet.users_permissions_user?.id,
        username: wallet.users_permissions_user?.username || 'Unknown',
        email: wallet.users_permissions_user?.email || 'N/A',
        firstName: wallet.users_permissions_user?.firstName || '',
        lastName: wallet.users_permissions_user?.lastName || '',
        userCreatedAt: wallet.users_permissions_user?.createdAt,
        walletCreatedAt: wallet.createdAt,
        walletUpdatedAt: wallet.updatedAt,
        currency: wallet.currency,
        type: wallet.type,
        balance: parseFloat(wallet.balance || 0),
        mainBalance: parseFloat(wallet.mainBalance || 0),
        promoBalance: parseFloat(wallet.promoBalance || 0),
        escrowBalance: parseFloat(wallet.escrowBalance || 0),
        pendingWithdrawalBalance: parseFloat(wallet.pendingWithdrawalBalance || 0),
        withdrawableBalance: parseFloat(wallet.mainBalance || 0) - parseFloat(wallet.promoBalance || 0)
      }));

      // If sorting by username was requested, sort the transformed data
      if (sortBy === 'username') {
        transformedWallets.sort((a, b) => {
          const comparison = a.username.localeCompare(b.username);
          return sortOrder === 'asc' ? comparison : -comparison;
        });
      }

      const pageCount = Math.ceil(total / parseInt(pageSize));

      ctx.send({
        data: transformedWallets,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount,
            total
          }
        }
      });

    } catch (error) {
      console.error('[ADMIN WALLET ERROR]', error);
      return ctx.internalServerError('Failed to fetch wallet information');
    }
  },

  /**
   * Get wallet statistics
   */
  async getWalletStats(ctx) {
    try {
      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} fetching wallet statistics`);

      // Get total wallets count
      const totalWallets = await strapi.db.query('api::user-wallet.user-wallet').count();

      // Get aggregated wallet data
      const wallets = await strapi.db.query('api::user-wallet.user-wallet').findMany({
        select: ['balance', 'mainBalance', 'promoBalance', 'escrowBalance', 'pendingWithdrawalBalance']
      });

      // Calculate statistics
      const stats = wallets.reduce((acc, wallet) => {
        acc.totalBalance += parseFloat(wallet.balance || 0);
        acc.totalMainBalance += parseFloat(wallet.mainBalance || 0);
        acc.totalPromoBalance += parseFloat(wallet.promoBalance || 0);
        acc.totalEscrowBalance += parseFloat(wallet.escrowBalance || 0);
        acc.totalPendingWithdrawal += parseFloat(wallet.pendingWithdrawalBalance || 0);
        return acc;
      }, {
        totalBalance: 0,
        totalMainBalance: 0,
        totalPromoBalance: 0,
        totalEscrowBalance: 0,
        totalPendingWithdrawal: 0
      });

      // Get recent transaction count (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const recentTransactions = await strapi.db.query('api::transaction.transaction').count({
        where: {
          createdAt: { $gte: thirtyDaysAgo }
        }
      });

      ctx.send({
        totalWallets,
        totalBalance: stats.totalBalance,
        totalMainBalance: stats.totalMainBalance,
        totalPromoBalance: stats.totalPromoBalance,
        totalEscrowBalance: stats.totalEscrowBalance,
        totalPendingWithdrawal: stats.totalPendingWithdrawal,
        recentTransactions,
        averageBalance: totalWallets > 0 ? stats.totalBalance / totalWallets : 0
      });

    } catch (error) {
      console.error('[ADMIN WALLET STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch wallet statistics');
    }
  },

  /**
   * Get specific user wallet details
   */
  async getUserWallet(ctx) {
    try {
      const { userId } = ctx.params;

      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} fetching wallet for user ${userId}`);

      // Get user wallet with user information
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId },
        populate: {
          users_permissions_user: {
            select: ['id', 'username', 'email', 'firstName', 'lastName', 'createdAt']
          }
        }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found for this user');
      }

      // Get recent transactions
      const transactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: { user_wallet: wallet.id },
        orderBy: { createdAt: 'desc' },
        limit: 10,
        populate: {
          user_wallet: {
            populate: {
              users_permissions_user: {
                select: ['username', 'email']
              }
            }
          }
        }
      });

      const transformedWallet = {
        id: wallet.id,
        userId: wallet.users_permissions_user?.id,
        username: wallet.users_permissions_user?.username || 'Unknown',
        email: wallet.users_permissions_user?.email || 'N/A',
        firstName: wallet.users_permissions_user?.firstName || '',
        lastName: wallet.users_permissions_user?.lastName || '',
        userCreatedAt: wallet.users_permissions_user?.createdAt,
        walletCreatedAt: wallet.createdAt,
        walletUpdatedAt: wallet.updatedAt,
        currency: wallet.currency,
        type: wallet.type,
        balance: parseFloat(wallet.balance || 0),
        mainBalance: parseFloat(wallet.mainBalance || 0),
        promoBalance: parseFloat(wallet.promoBalance || 0),
        escrowBalance: parseFloat(wallet.escrowBalance || 0),
        pendingWithdrawalBalance: parseFloat(wallet.pendingWithdrawalBalance || 0),
        withdrawableBalance:  parseFloat(wallet.mainBalance || 0),
        recentTransactions: transactions.map(tx => ({
          id: tx.id,
          type: tx.type,
          amount: parseFloat(tx.amount || 0),
          description: tx.description,
          status: tx.status,
          createdAt: tx.createdAt,
          updatedAt: tx.updatedAt
        }))
      };

      ctx.send(transformedWallet);

    } catch (error) {
      console.error('[ADMIN WALLET USER ERROR]', error);
      return ctx.internalServerError('Failed to fetch user wallet information');
    }
  },

  /**
   * Get user wallet transactions
   */
  async getUserTransactions(ctx) {
    try {
      const { userId } = ctx.params;
      const { page = 1, pageSize = 20, type, status } = ctx.query;

      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} fetching transactions for user ${userId}`);

      // Get user wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found for this user');
      }

      // Build transaction filters
      const filters = { user_wallet: wallet.id };
      if (type) filters.type = type;
      if (status) filters.status = status;

      // Get transactions
      const transactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: filters,
        orderBy: { createdAt: 'desc' },
        limit: parseInt(pageSize),
        offset: (parseInt(page) - 1) * parseInt(pageSize)
      });

      // Get total count
      const total = await strapi.db.query('api::transaction.transaction').count({
        where: filters
      });

      const pageCount = Math.ceil(total / parseInt(pageSize));

      ctx.send({
        data: transactions.map(tx => ({
          id: tx.id,
          type: tx.type,
          amount: parseFloat(tx.amount || 0),
          description: tx.description,
          status: tx.status,
          createdAt: tx.createdAt,
          updatedAt: tx.updatedAt
        })),
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount,
            total
          }
        }
      });

    } catch (error) {
      console.error('[ADMIN WALLET TRANSACTIONS ERROR]', error);
      return ctx.internalServerError('Failed to fetch user transactions');
    }
  },

  /**
   * Update user wallet balance (admin action)
   */
  async updateWalletBalance(ctx) {
    try {
      const { userId } = ctx.params;
      const { mainBalance, promoBalance, reason } = ctx.request.body;

      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} updating wallet balance for user ${userId}`);

      // Get user wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found for this user');
      }

      // Update wallet balance
      const updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
        data: {
          mainBalance: mainBalance !== undefined ? mainBalance : wallet.mainBalance,
          promoBalance: promoBalance !== undefined ? promoBalance : wallet.promoBalance,
          balance: (mainBalance !== undefined ? mainBalance : wallet.mainBalance) + 
                   (promoBalance !== undefined ? promoBalance : wallet.promoBalance)
        }
      });

      // Create admin transaction record
      if (reason) {
        await strapi.entityService.create('api::transaction.transaction', {
          data: {
            user_wallet: wallet.id,
            type: 'admin_adjustment',
            amount: 0, // Balance adjustment, not a monetary transaction
            description: `Admin balance adjustment: ${reason}`,
            status: 'completed',
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });
      }

      ctx.send({
        message: 'Wallet balance updated successfully',
        wallet: {
          id: updatedWallet.id,
          mainBalance: parseFloat(updatedWallet.mainBalance || 0),
          promoBalance: parseFloat(updatedWallet.promoBalance || 0),
          balance: parseFloat(updatedWallet.balance || 0)
        }
      });

    } catch (error) {
      console.error('[ADMIN WALLET UPDATE ERROR]', error);
      return ctx.internalServerError('Failed to update wallet balance');
    }
  },

  /**
   * Create manual transaction (admin action)
   */
  async createTransaction(ctx) {
    try {
      const { userId } = ctx.params;
      const { type, amount, description, status = 'completed' } = ctx.request.body;

      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} creating transaction for user ${userId}`);

      // Get user wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found for this user');
      }

      // Create transaction
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          user_wallet: wallet.id,
          type,
          amount: parseFloat(amount),
          description: description || `Admin ${type}`,
          status,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      ctx.send({
        message: 'Transaction created successfully',
        transaction: {
          id: transaction.id,
          type: transaction.type,
          amount: parseFloat(transaction.amount || 0),
          description: transaction.description,
          status: transaction.status,
          createdAt: transaction.createdAt
        }
      });

    } catch (error) {
      console.error('[ADMIN WALLET TRANSACTION ERROR]', error);
      return ctx.internalServerError('Failed to create transaction');
    }
  }

};
