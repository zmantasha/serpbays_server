'use strict';

/**
 * user-wallet controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::user-wallet.user-wallet', ({ strapi }) => ({
  // Get current user's wallet
  async getWallet(ctx) {
    try {
      const userId = ctx.state?.user?.id;
      if (!userId) {
        return ctx.unauthorized('Authentication required');
      }

      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId },
        populate: ['transactions']
      });

      if (!wallet) {
        // Create a new wallet if not found
        const user = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { id: userId }
        });

        if (!user) {
          return ctx.notFound('User not found');
        }

        const newWallet = await strapi.entityService.create('api::user-wallet.user-wallet', {
          data: {
            users_permissions_user: userId,
            type: user.role?.name === 'publisher' ? 'publisher' : 'advertiser',
            balance: 0,
            escrowBalance: 0,
            currency: 'USD',
            publishedAt: new Date()
          }
        });

        return { data: newWallet };
      }

      return { data: wallet };
    } catch (error) {
      console.error('Error getting wallet:', error);
      return ctx.badRequest('Failed to get wallet');
    }
  },

  // Create a transaction
  async createTransaction(ctx) {
    try {
      const userId = ctx.state?.user?.id;
      if (!userId) {
        return ctx.unauthorized('Authentication required');
      }

      const { type, amount, gateway, gatewayTransactionId, metadata } = ctx.request.body;

      // Get user's wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }

      // Create transaction
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type,
          amount,
          status: 'pending',
          gateway,
          gatewayTransactionId,
          metadata,
          user_wallet: wallet.id,
          publishedAt: new Date()
        }
      });

      // Update wallet balance based on transaction type
      let newBalance = parseFloat(wallet.balance);
      let newEscrowBalance = parseFloat(wallet.escrowBalance);

      switch (type) {
        case 'deposit':
          newBalance += parseFloat(amount);
          break;
        case 'escrow_hold':
          newBalance -= parseFloat(amount);
          newEscrowBalance += parseFloat(amount);
          break;
        case 'escrow_release':
          newEscrowBalance -= parseFloat(amount);
          break;
        case 'payout':
          newBalance -= parseFloat(amount);
          break;
        case 'refund':
          newBalance += parseFloat(amount);
          break;
      }

      // Update wallet
      await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
        data: {
          balance: newBalance.toString(),
          escrowBalance: newEscrowBalance.toString()
        }
      });

      return { data: transaction };
    } catch (error) {
      console.error('Error creating transaction:', error);
      return ctx.badRequest('Failed to create transaction');
    }
  },

  // Get wallet transactions
  async getTransactions(ctx) {
    try {
      const userId = ctx.state?.user?.id;
      if (!userId) {
        return ctx.unauthorized('Authentication required');
      }

      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }

      const transactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: { user_wallet: wallet.id },
        orderBy: { createdAt: 'DESC' }
      });

      return { data: transactions };
    } catch (error) {
      console.error('Error getting transactions:', error);
      return ctx.badRequest('Failed to get transactions');
    }
  }
}));
