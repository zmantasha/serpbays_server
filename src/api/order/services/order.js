'use strict';

/**
 * order service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::order.order', ({ strapi }) => ({
  // Extend the default create method to handle escrow
  async create(data, user) {
    try {
      // Check if user was passed properly
      if (!user) {
        throw new Error('Authentication required');
      }

      // Get user wallet - ensure user ID is properly formatted
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: user.id,
          type: 'advertiser'
        },
        populate: ['users_permissions_user']
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

      // Debug log to check data format
      console.log('Creating order with data:', orderData);

      // Use database transaction to ensure everything completes or nothing does
      const result = await strapi.db.transaction(async ({ trx }) => {
        // Create the order using the proper format for Strapi service
        const order = await super.create({ data: orderData });

        // Verify the order was created successfully
        if (!order || !order.id) {
          throw new Error('Failed to create order record');
        }

        console.log('Order created:', order);

        // Create the transaction record for escrow hold
        // const transactionRecord = await strapi.service('api::transaction.transaction').create({
        //   data: {
        //     type: 'escrow_hold',
        //     amount: escrowHeld,
        //     netAmount: escrowHeld, 
        //     transactionStatus: 'success',
        //     gateway: 'internal',
        //     gatewayTransactionId: `escrow_${order.id}_${Date.now()}`,
        //     description: `Escrow hold for order #${order.id}`,
        //     user_wallet: wallet.id,
        //     order: order.id,
        //   }
        // });

        // console.log('Transaction created:', transactionRecord);

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
  },

  // Get order with all related content
  async getCompleteOrder(id) {
    return await strapi.entityService.findOne('api::order.order', id, {
      populate: ['advertiser', 'publisher', 'website', 'orderContent', 'transactions'],
    });
  },

  // When an order is delivered, make content readable to the advertiser
  async markAsDelivered(id, deliveryData = {}) {
    const order = await this.getCompleteOrder(id);
    
    if (!order) {
      throw new Error('Order not found');
    }
    
    if (order.status !== 'accepted') {
      throw new Error('Only accepted orders can be marked as delivered');
    }
    
    // Update with delivery proof if provided
    const updateData = {
      status: 'delivered',
      deliveryProof: deliveryData.proof || order.deliveryProof,
    };
    
    // Update the order
    return await strapi.entityService.update('api::order.order', id, {
      data: updateData,
    });
  },

  // When an order is completed, transfer funds from escrow to publisher
  async completeOrder(id) {
    const order = await this.getCompleteOrder(id);
    
    if (!order) {
      throw new Error('Order not found');
    }
    
    if (order.status !== 'delivered') {
      throw new Error('Only delivered orders can be completed');
    }
    
    // Release escrow funds - Use actual transaction handling code here
    // ... (existing escrow release code)
    
    // Update the order
    return await strapi.entityService.update('api::order.order', id, {
      data: {
        status: 'approved',
      },
    });
  }
}));
