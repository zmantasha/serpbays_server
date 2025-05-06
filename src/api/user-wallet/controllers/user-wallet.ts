/**
 * user-wallet controller
 */

import { factories } from '@strapi/strapi'

export default factories.createCoreController('api::user-wallet.user-wallet', ({ strapi }) => ({
  async getWallet(ctx) {
    console.log(ctx)
    try {
      const userId = ctx.state.user.id;
      
      const wallet = await strapi.service('api::user-wallet.user-wallet').getWallet(userId);
      
      return ctx.send({
        data: wallet
      });
    } catch (error) {
      return ctx.badRequest('Failed to get wallet', { error: error.message });
    }
  },

  async addFunds(ctx) {
    try {
      const userId = ctx.state.user.id;
      const { amount, gateway } = ctx.request.body;
      console.log(userId)
      if (!amount || amount <= 0) {
        return ctx.badRequest('Invalid amount');
      }

      const wallet = await strapi.service('api::user-wallet.user-wallet').getWallet(userId);

      // Create pending transaction
      const transaction = await strapi.service('api::user-wallet.user-wallet').createTransaction(wallet.id, {
        type: 'deposit',
        amount,
        gateway,
        status: 'pending'
      });

      // Initialize payment gateway based on selection
      let paymentData;
      switch (gateway) {
        case 'razorpay':
          paymentData = await strapi.service('api::payment.razorpay').createOrder(amount);
          break;
        case 'paypal':
          paymentData = await strapi.service('api::payment.paypal').createPayment(amount);
          break;
        case 'stripe':
          paymentData = await strapi.service('api::payment.stripe').createPaymentIntent(amount);
          break;
        default:
          return ctx.badRequest('Invalid payment gateway');
      }

      return ctx.send({
        data: {
          transaction,
          payment: paymentData
        }
      });
    } catch (error) {
      return ctx.badRequest('Failed to add funds', { error: error.message });
    }
  },

  async getTransactions(ctx) {
    try {
      const userId = ctx.state.user.id;
      const wallet = await strapi.service('api::user-wallet.user-wallet').getWallet(userId);
      
      const transactions = await strapi.service('api::user-wallet.user-wallet').getTransactions(wallet.id);
      
      return ctx.send({
        data: transactions
      });
    } catch (error) {
      return ctx.badRequest('Failed to get transactions', { error: error.message });
    }
  },

  async processEscrow(ctx) {
    try {
      const { walletId, amount, type } = ctx.request.body;

      if (!amount || amount <= 0) {
        return ctx.badRequest('Invalid amount');
      }

      // Create transaction
      const transaction = await strapi.service('api::user-wallet.user-wallet').createTransaction(walletId, {
        type,
        amount,
        status: 'pending'
      });

      // Update wallet balance
      await strapi.service('api::user-wallet.user-wallet').updateWalletBalance(walletId, amount, type);

      // Update transaction status
      await strapi.entityService.update('api::wallet-transaction.wallet-transaction', transaction.id, {
        data: { status: 'success' }
      });

      return ctx.send({
        data: transaction
      });
    } catch (error) {
      return ctx.badRequest('Failed to process escrow', { error: error.message });
    }
  },

  async processPayout(ctx) {
    try {
      const { walletId, amount, gateway } = ctx.request.body;

      if (!amount || amount <= 0) {
        return ctx.badRequest('Invalid amount');
      }

      const wallet = await strapi.entityService.findOne('api::user-wallet.user-wallet', walletId);
      
      if (!wallet || wallet.balance < amount) {
        return ctx.badRequest('Insufficient balance');
      }

      // Create transaction
      const transaction = await strapi.service('api::user-wallet.user-wallet').createTransaction(walletId, {
        type: 'payout',
        amount,
        gateway,
        status: 'pending'
      });

      // Initialize payout based on gateway
      let payoutData;
      switch (gateway) {
        case 'razorpay':
          payoutData = await strapi.service('api::payment.razorpay').createPayout(amount);
          break;
        case 'paypal':
          payoutData = await strapi.service('api::payment.paypal').createPayout(amount);
          break;
        case 'stripe':
          payoutData = await strapi.service('api::payment.stripe').createPayout(amount);
          break;
        default:
          return ctx.badRequest('Invalid payout gateway');
      }

      // Update wallet balance
      await strapi.service('api::user-wallet.user-wallet').updateWalletBalance(walletId, amount, 'payout');

      // Update transaction status
      await strapi.entityService.update('api::wallet-transaction.wallet-transaction', transaction.id, {
        data: { 
          status: 'success',
          gatewayTransactionId: payoutData.id
        }
      });

      return ctx.send({
        data: {
          transaction,
          payout: payoutData
        }
      });
    } catch (error) {
      return ctx.badRequest('Failed to process payout', { error: error.message });
    }
  }
}));
