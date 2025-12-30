'use strict';

/**
 * Admin Wallet Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::user-wallet.user-wallet', ({ strapi }) => ({

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
        return ctx.send({
          data: {
            id: null,
            mainBalance: 0,
            promoBalance: 0,
            escrowBalance: 0,
            pendingWithdrawalBalance: 0,
            withdrawableBalance: 0,
            currency: 'USD',
            type: 'user',
            walletCreatedAt: null,
            walletUpdatedAt: null
          }
        });
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
        withdrawableBalance: parseFloat(wallet.mainBalance || 0),
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
  },

  /**
   * Handle wallet operations (add funds, remove funds, set balance, transfer)
   */
  async walletOperation(ctx) {
    try {
      const { walletId } = ctx.params;
      const {
        type,
        amount,
        transactionType,
        transactionId,
        reason,
        notes,
        targetUserId,
        fundSource = 'main'
      } = ctx.request.body;

      console.log(`[ADMIN WALLET OPERATION] Admin ${ctx.state.user.id} performing ${type} operation on wallet ${walletId}`);

      // Validate required fields
      if (!type || !amount || !transactionType || !transactionId || !reason) {
        return ctx.badRequest('Missing required fields: type, amount, transactionType, transactionId, reason');
      }

      // Validate amount
      if (amount <= 0) {
        return ctx.badRequest('Amount must be greater than 0');
      }

      // Validate operation type
      const validTypes = ['add_funds', 'remove_funds', 'set_balance', 'transfer_funds'];
      if (!validTypes.includes(type)) {
        return ctx.badRequest('Invalid operation type');
      }

      // Get the wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId },
        populate: ['users_permissions_user']
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }

      // Get admin user info for logging
      const adminUser = ctx.state.user;
      if (!adminUser) {
        return ctx.unauthorized('Admin authentication required');
      }

      // Start database transaction
      const result = await strapi.db.transaction(async (trx) => {
        let updatedWallet;
        let transactionRecord;
        let targetWallet = null;

        switch (type) {
          case 'add_funds':
            // Add funds to specified balance type
            const addUpdateData = {};
            addUpdateData[`${fundSource}Balance`] = wallet[`${fundSource}Balance`] + amount;
            addUpdateData.balance = wallet.balance + amount;

            updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
              data: addUpdateData
            });

            // Create transaction record
            transactionRecord = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'deposit', // Use valid enum value
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: 'main_fund', // Use valid enum value
                description: `Admin added funds: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Admin: ${adminUser.username} | Type: ${transactionType} | Notes: ${notes || 'N/A'}`,
                user_wallet: walletId,
                users_permissions_user: wallet.users_permissions_user.id,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });
            break;

          case 'remove_funds':
            // Check sufficient balance
            if (wallet[`${fundSource}Balance`] < amount) {
              throw new Error(`Insufficient ${fundSource} balance`);
            }

            // Remove funds from specified balance type
            const removeUpdateData = {};
            removeUpdateData[`${fundSource}Balance`] = wallet[`${fundSource}Balance`] - amount;
            removeUpdateData.balance = wallet.balance - amount;

            updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
              data: removeUpdateData
            });

            // Create transaction record
            transactionRecord = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'withdrawal', // Use valid enum value
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: fundSource === 'main' ? 'main_fund' : 'promo_fund', // Use valid enum value
                description: `Admin removed funds: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Admin: ${adminUser.username} | Type: ${transactionType} | Notes: ${notes || 'N/A'}`,
                user_wallet: walletId,
                users_permissions_user: wallet.users_permissions_user.id,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });
            break;

          case 'set_balance':
            // Set specific balance amounts
            const setUpdateData = {
              mainBalance: fundSource === 'main' ? amount : wallet.mainBalance,
              promoBalance: fundSource === 'promo' ? amount : wallet.promoBalance,
              escrowBalance: fundSource === 'escrow' ? amount : wallet.escrowBalance,
              balance: 0 // Will be recalculated
            };

            // Recalculate total balance
            setUpdateData.balance = setUpdateData.mainBalance + setUpdateData.promoBalance + setUpdateData.escrowBalance;

            updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
              data: setUpdateData
            });

            // Create transaction record
            transactionRecord = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'deposit', // Use valid enum value for balance setting
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: fundSource === 'main' ? 'main_fund' : 'promo_fund', // Use valid enum value
                description: `Admin set ${fundSource} balance: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Notes: ${notes || 'N/A'}`,
                user_wallet: walletId,
                users_permissions_user: wallet.users_permissions_user.id,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });
            break;

          case 'transfer_funds':
            if (!targetUserId) {
              throw new Error('Target user ID required for transfer');
            }

            // Check sufficient balance
            if (wallet[`${fundSource}Balance`] < amount) {
              throw new Error(`Insufficient ${fundSource} balance for transfer`);
            }

            // Get target wallet
            targetWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
              where: { users_permissions_user: targetUserId }
            });

            if (!targetWallet) {
              throw new Error('Target user wallet not found');
            }

            // Update source wallet
            const sourceUpdateData = {};
            sourceUpdateData[`${fundSource}Balance`] = wallet[`${fundSource}Balance`] - amount;
            sourceUpdateData.balance = wallet.balance - amount;

            await strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
              data: sourceUpdateData
            });

            // Update target wallet
            const targetUpdateData = {};
            targetUpdateData[`${fundSource}Balance`] = targetWallet[`${fundSource}Balance`] + amount;
            targetUpdateData.balance = targetWallet.balance + amount;

            await strapi.entityService.update('api::user-wallet.user-wallet', targetWallet.id, {
              data: targetUpdateData
            });

            // Create transaction records for both wallets
            const sourceTransaction = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'withdrawal', // Use valid enum value
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: fundSource === 'main' ? 'main_fund' : 'promo_fund', // Use valid enum value
                description: `Transfer to user ${targetUserId}: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Admin: ${adminUser.username} | Type: ${transactionType} | Notes: ${notes || 'N/A'}`,
                user_wallet: walletId,
                users_permissions_user: wallet.users_permissions_user.id,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });

            const targetTransaction = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'deposit', // Use valid enum value
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: fundSource === 'main' ? 'main_fund' : 'promo_fund', // Use valid enum value
                description: `Transfer from user ${wallet.users_permissions_user.id}: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Admin: ${adminUser.username} | Type: ${transactionType} | Notes: ${notes || 'N/A'}`,
                user_wallet: targetWallet.id,
                users_permissions_user: targetUserId,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });

            updatedWallet = await strapi.entityService.findOne('api::user-wallet.user-wallet', walletId);
            transactionRecord = sourceTransaction;
            break;

          default:
            throw new Error('Invalid operation type');
        }

        // Create admin audit log
        await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
          data: {
            adminUser: adminUser.id,
            action: `wallet_${type}`,
            targetUser: wallet.users_permissions_user.id,
            details: {
              walletId: walletId,
              operation: type,
              amount: amount,
              transactionType: transactionType,
              transactionId: transactionId,
              reason: reason,
              notes: notes,
              fundSource: fundSource,
              targetUserId: targetUserId,
              previousBalance: wallet.balance,
              newBalance: updatedWallet.balance,
              transactionRecordId: transactionRecord.id
            },
            ipAddress: ctx.request.ip,
            userAgent: ctx.request.headers['user-agent'],
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });

        return {
          wallet: updatedWallet,
          transaction: transactionRecord,
          targetWallet: targetWallet
        };
      });

      // Send notification to user
      try {
        await strapi.service('api::notification.notification').create({
          data: {
            user: wallet.users_permissions_user.id,
            type: 'wallet_operation',
            title: 'Wallet Updated',
            message: `Your wallet has been updated by admin. ${type.replace('_', ' ')}: $${amount}`,
            data: {
              operation: type,
              amount: amount,
              transactionId: transactionId,
              reason: reason
            },
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });
      } catch (notificationError) {
        console.error('Failed to send notification:', notificationError);
        // Don't fail the operation if notification fails
      }

      console.log(`[ADMIN WALLET OPERATION] Successfully completed ${type} operation on wallet ${walletId}`);

      ctx.body = {
        success: true,
        message: 'Wallet operation completed successfully',
        data: {
          wallet: result.wallet,
          transaction: result.transaction,
          targetWallet: result.targetWallet
        }
      };

    } catch (error) {
      console.error('[ADMIN WALLET OPERATION ERROR]', error);
      ctx.internalServerError('Failed to perform wallet operation: ' + error.message);
    }
  }

}));
