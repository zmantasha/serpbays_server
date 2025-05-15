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
        orderStatus: 'pending',
      };

      // Debug log to check data format
      console.log('Creating order with data:', orderData);

      // Use database transaction to ensure everything completes or nothing does
      const result = await strapi.db.transaction(async ({ trx }) => {
        // Create the order using the proper format for Strapi service
        const order = await strapi.entityService.create('api::order.order', {
          data: orderData
        });

        // Verify the order was created successfully
        if (!order || !order.id) {
          throw new Error('Failed to create order record');
        }

        console.log('Order created:', order);

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
      // Log error details if available 
      if (error.details && error.details.errors) {
        console.error('Validation errors:', error.details.errors);
      }
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
    
    if (order.orderStatus !== 'accepted') {
      throw new Error('Only accepted orders can be marked as delivered');
    }
    
    // Update with delivery proof if provided
    const updateData = {
      orderStatus: 'delivered',
      deliveryProof: deliveryData.proof || order.deliveryProof,
    };
    
    // Update the order
    return await strapi.entityService.update('api::order.order', id, {
      data: updateData,
    });
  },

  // When an order is completed, transfer funds from escrow to publisher
  async completeOrder(id, user) {
    // Use transaction to ensure data consistency
    return await strapi.db.transaction(async ({ trx }) => {
      // Get the order with all relations
      const order = await this.getCompleteOrder(id);
      console.log("order",order)
      
      if (!order) {
        throw new Error('Order not found');
      }
      
      // Prevent duplicate completions - check if already approved
      if (order.orderStatus === 'approved') {
        return order; // Already completed, return existing order
      }
      
      if (order.orderStatus !== 'delivered') {
        throw new Error('Only delivered orders can be completed');
      }
      
      // Make sure publisher exists
      if (!order.publisher || !order.publisher.id) {
        throw new Error('Order has no assigned publisher');
      }
      
      // Get advertiser and publisher wallets
      const advertiserWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: order.advertiser.id,
          type: 'advertiser'
        }
      });
      
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: order.publisher.id,
          type: 'publisher'
        }
      });
      
      if (!advertiserWallet) {
        throw new Error('Advertiser wallet not found');
      }
      
      if (!publisherWallet) {
        throw new Error('Publisher wallet not found');
      }
      
      // Calculate payment amount (without platform fee)
      const paymentAmount = order.totalAmount;
      
      // Release escrow funds - Update advertiser wallet
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          escrowBalance: advertiserWallet.escrowBalance - order.escrowHeld
        }
      });
      
      // Add funds to publisher wallet
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: {
          balance: publisherWallet.balance + paymentAmount
        }
      });
      
      // Create transaction record for the payment
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'escrow_release',
          amount: paymentAmount,
          netAmount: paymentAmount,
          fee: order.platformFee,
          transactionStatus: 'success',
          gateway: 'internal',
          gatewayTransactionId: `release_${order.id}_${Date.now()}`,
          description: `Payment for order #${order.id}`,
          user_wallet: publisherWallet.id,
          order: order.id
        }
      });
      
      // Create platform fee transaction
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'platform_fee',
          amount: order.platformFee,
          netAmount: order.platformFee,
          fee: 0,
          transactionStatus: 'success',
          gateway: 'internal',
          gatewayTransactionId: `fee_${order.id}_${Date.now()}`,
          description: `Platform fee for order #${order.id}`,
          // This would go to the platform wallet in a production system
          order: order.id
        }
      });
      
      // Update the order
      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: {
          orderStatus: 'approved',
          completedDate: new Date()
        }
      });
      
      return updatedOrder;
    });
  }
}));
