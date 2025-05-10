'use strict';

/**
 * order service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::order.order', ({ strapi }) => ({
  // Extend the default create method to handle escrow
  async create(data) {
    try {
      // Get the user from context
      const { user } = strapi.requestContext.get();
      if (!user) {
        throw new Error('Authentication required');
      }

      // Get user wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: user.id,
          type: 'advertiser'
        },
      });

      if (!wallet) {
        throw new Error('Advertiser wallet not found');
      }

      // Calculate fee
      const feeRate = data.feeRate || 0.1; // Default 10% if not specified
      const totalAmount = parseFloat(data.totalAmount);
      const platformFee = parseFloat((totalAmount * feeRate).toFixed(2));
      const escrowHeld = totalAmount + platformFee;

      // Check if user has sufficient balance
      if (wallet.balance < escrowHeld) {
        throw new Error('Insufficient funds');
      }

      // Create the order with current date
      const orderData = {
        ...data,
        advertiser: user.id,
        feeRate,
        platformFee,
        escrowHeld,
        orderDate: new Date(),
        status: 'pending',
      };

      // Use database transaction to ensure everything completes or nothing does
      const result = await strapi.db.transaction(async ({ trx }) => {
        // Create the order
        const order = await super.create(orderData);

        // Create the transaction record for escrow hold
        const transactionRecord = await strapi.service('api::transaction.transaction').create({
          data: {
            type: 'escrow_hold',
            amount: escrowHeld,
            netAmount: escrowHeld, 
            transactionStatus: 'success',
            gateway: 'internal',
            gatewayTransactionId: `escrow_${order.id}_${Date.now()}`,
            description: `Escrow hold for order #${order.id}`,
            user_wallet: wallet.id,
            order: order.id,
          }
        });

        // Update wallet balances - subtract from balance, add to escrow
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: wallet.id },
          data: {
            balance: wallet.balance - escrowHeld,
            escrowBalance: wallet.escrowBalance + escrowHeld
          }
        });

        return order;
      });

      return result;
    } catch (error) {
      console.error('Order creation failed:', error);
      throw error;
    }
  }
}));
