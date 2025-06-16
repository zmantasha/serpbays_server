'use strict';

/**
 * user-wallet controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::user-wallet.user-wallet', ({ strapi }) => ({
  // Override the default find method
  async find(ctx) {
    try {
      const userId = ctx.state?.user?.id;
      console.log("stx",ctx.state)
      if (!userId) {
        return ctx.unauthorized('Authentication required');
      }

      const wallets = await strapi.db.query('api::user-wallet.user-wallet').findMany({
        where: { users_permissions_user: userId }
      });

      return { data: wallets };
    } catch (error) {
      return ctx.badRequest('Failed to find wallets');
    }
  },

  // Get wallet balance
  async getBalance(ctx) {
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

      return {
        data: {
          balance: wallet.balance || "0",
          escrowBalance: wallet.escrowBalance || "0",
          currency: wallet.currency || "USD"
        }
      };
    } catch (error) {
      return ctx.badRequest('Failed to get balance');
    }
  },

  // Get transaction history
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
        orderBy: { createdAt: 'DESC' },
        populate: ['invoice']
      });

      // Transform the data to include invoice information
      const transformedTransactions = transactions.map(transaction => ({
        ...transaction,
        invoice: transaction.invoice ? {
          id: transaction.invoice.id,
          invoiceNumber: transaction.invoice.invoiceNumber,
          pdfUrl: transaction.invoice.pdfUrl
        } : null
      }));

      return { data: transformedTransactions };
    } catch (error) {
      return ctx.badRequest('Failed to get transactions');
    }
  },

  // Create wallet
  async createWallet(ctx) {
    try {
      const userId = ctx.state?.user?.id;
      console.log(ctx.state)
      if (!userId) {
        return ctx.unauthorized('Authentication required');
      }

      // Check if wallet already exists
      const existingWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (existingWallet) {
        return ctx.badRequest('Wallet already exists');
      }

      const data = ctx.request.body;
      data.users_permissions_user = userId;
      data.balance = "0";
      data.escrowBalance = "0";
      data.currency = data.currency || 'USD';
      data.status = 'active';

      const wallet = await strapi.entityService.create('api::user-wallet.user-wallet', {
        data
      });

      return { data: wallet };
    } catch (error) {
      return ctx.badRequest('Failed to create wallet');
    }
  },

  // Redeem promo code
  async redeemPromo(ctx) {
    try {
      const userId = ctx.state?.user?.id;
      if (!userId) {
        return ctx.unauthorized('Authentication required');
      }

      const { promoCode } = ctx.request.body;
      if (!promoCode) {
        return ctx.badRequest('Promo code is required');
      }

      // Find user's wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }

      // Find the promo code in the database
      const promo = await strapi.db.query('api::promo-code.promo-code').findOne({
        where: { 
          code: promoCode,
          promoStatus: 'active',
          expiryDate: {
            $gt: new Date()
          }
        }
      });

      if (!promo) {
        return ctx.badRequest('Invalid or expired promo code');
      }

      // Check if user has already used this promo code
      const existingRedemption = await strapi.db.query('api::promo-redemption.promo-redemption').findOne({
        where: { 
          promoCode: promo.id,
          user: userId
        }
      });

      if (existingRedemption) {
        return ctx.badRequest('You have already used this promo code');
      }

      // Update wallet balance
      const currentBalance = parseFloat(wallet.balance) || 0;
      const promoAmount = parseFloat(promo.amount) || 0;
      const newBalance = currentBalance + promoAmount;

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: wallet.id },
        data: {
          balance: newBalance.toString()
        }
      });

      // Create transaction record
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'promo',
          amount: promoAmount,
          netAmount: promoAmount,
          transactionStatus: 'success',
          gateway: 'promo',
          description: `Promo code redemption: ${promoCode}`,
          user_wallet: wallet.id,
          publishedAt: new Date()
        }
      });

      // Record promo code redemption
      await strapi.entityService.create('api::promo-redemption.promo-redemption', {
        data: {
          promoCode: promo.id,
          user: userId,
          redeemedAt: new Date(),
          publishedAt: new Date()
        }
      });

      return {
        data: {
          amount: promoAmount,
          message: `Successfully redeemed promo code for $${promoAmount}`
        }
      };
    } catch (error) {
      console.error('Promo redemption error:', error);
      return ctx.badRequest('Failed to redeem promo code');
    }
  }
}));
