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
      populate: ['advertiser', 'publisher', 'website', 'orderContent', 'outsourcedContent', 'transactions'],
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

  // When an order is completed, mark funds as available to publisher but don't transfer yet
  async completeOrder(id, user) {
    // Use transaction to ensure data consistency
    return await strapi.db.transaction(async ({ trx }) => {
      // Get the order with all relations
      const order = await this.getCompleteOrder(id);
      console.log("Processing order completion:", { 
        orderId: id, 
        status: order.orderStatus, 
        totalAmount: order.totalAmount 
      });
      
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
      
      // Make sure publisher exists and get the publisher ID
      if (!order.publisher) {
        throw new Error('Order has no assigned publisher');
      }
      
      // Get publisher and advertiser IDs (handling both object and direct ID references)
      const publisherId = order.publisher.id || order.publisher;
      const advertiserId = order.advertiser.id || order.advertiser;
      
      console.log("Getting wallets for:", { publisherId, advertiserId });
      
      // Get advertiser and publisher wallets
      const advertiserWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: advertiserId,
          type: 'advertiser'
        }
      });
      
      let publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: publisherId,
          type: 'publisher'
        }
      });
      
      if (!advertiserWallet) {
        throw new Error('Advertiser wallet not found');
      }
      
      // Create publisher wallet if it doesn't exist
      if (!publisherWallet) {
        console.log(`Publisher wallet not found, creating one for user ${publisherId}`);
        publisherWallet = await strapi.entityService.create('api::user-wallet.user-wallet', {
          data: {
            users_permissions_user: publisherId,
            type: 'publisher',
            balance: 0,
            escrowBalance: 0,
            currency: 'USD',
            status: 'active',
            publishedAt: new Date()
          },
        });
        
        if (!publisherWallet) {
          throw new Error('Failed to create publisher wallet');
        }
        console.log(`Created new publisher wallet with ID: ${publisherWallet.id}`);
      }
      
      // Calculate payment amount (without platform fee)
      const paymentAmount = order.totalAmount;
      
      console.log("Processing payment:", {
        paymentAmount,
        escrowHeld: order.escrowHeld,
        platformFee: order.platformFee,
        advertiserWalletId: advertiserWallet.id,
        publisherWalletId: publisherWallet.id
      });
      
      // Release escrow funds from advertiser wallet - this is the approval step
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          escrowBalance: advertiserWallet.escrowBalance - order.escrowHeld
        }
      });
      
      // DON'T add to publisher wallet balance directly - only create transaction record
      // The getAvailableBalance method will calculate available funds from transactions
      
      // Create a transaction record for the payment (this is what shows in earnings)
      const paymentTransaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'escrow_release',
          amount: paymentAmount,
          netAmount: paymentAmount,
          fee: order.platformFee,
          transactionStatus: 'success', // Mark as success since funds are now available
          gateway: 'test',
          gatewayTransactionId: `completed_${order.id}_${Date.now()}`,
          description: `Payment for order #${order.id} - funds available for withdrawal`,
          user_wallet: publisherWallet.id,
          order: order.id
        }
      });
      
      // Create platform fee transaction
      const feeTransaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'fee',
          amount: order.platformFee,
          netAmount: order.platformFee,
          fee: 0,
          transactionStatus: 'success',
          gateway: 'test',
          gatewayTransactionId: `fee_${order.id}_${Date.now()}`,
          description: `Platform fee for order #${order.id}`,
          // This would go to the platform wallet in a production system
          order: order.id
        }
      });
      
      console.log("Created transactions:", {
        paymentTransactionId: paymentTransaction.id,
        feeTransactionId: feeTransaction.id
      });
      
      // Update the order
      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: {
          orderStatus: 'completed',
          completedDate: new Date(),
          orderAccepted: true
        }
      });
      
      console.log(`Order ${id} completed successfully and marked available for withdrawal`);
      return updatedOrder;
    });
  }
}));
