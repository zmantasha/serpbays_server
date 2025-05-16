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

      console.log(`Creating order for user ID: ${user.id}, username: ${user.username || 'unknown'}`);

      // Validate that we have required fields for creating an order
      if (!data.totalAmount) {
        throw new Error('Total amount is required');
      }

      if (!data.website) {
        throw new Error('Website is required');
      }

      // Get user wallet - ensure user ID is properly formatted
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: user.id,
          type: 'advertiser'
        },
        populate: ['users_permissions_user']
      });

      console.log('Wallet check result:', wallet ? 'Found wallet' : 'No wallet found');

      // If wallet doesn't exist, create one automatically
      if (!wallet) {
        console.log(`No advertiser wallet found for user ${user.id}. Creating a new wallet.`);
        try {
          // Create a new wallet with zero balance
          const newWallet = await strapi.entityService.create('api::user-wallet.user-wallet', {
            data: {
              type: 'advertiser',
              users_permissions_user: user.id,
              balance: 0,
              escrowBalance: 0,
              description: 'Automatically created advertiser wallet'
            }
          });
          
          console.log('Created new wallet:', newWallet);
          
          // For the first wallet creation, we'll need to return a special error
          throw new Error('New wallet created with zero balance. Please add funds to your wallet before creating an order.');
        } catch (walletError) {
          console.error('Error creating wallet:', walletError);
          throw new Error(walletError.message || 'Advertiser wallet not found and could not be created');
        }
      }

      // Calculate fee
      const feeRate = data.feeRate || 0.1; // Default 10% if not specified
      const totalAmount = parseFloat(data.totalAmount);
      
      // Handle NaN values
      if (isNaN(totalAmount)) {
        throw new Error('Invalid total amount');
      }
      
      const platformFee = parseFloat((totalAmount * feeRate).toFixed(2));
      const escrowHeld = totalAmount + platformFee;

      // Check if user has sufficient balance
      const walletBalance = parseFloat(wallet.balance || 0);
      if (isNaN(walletBalance)) {
        console.log('Invalid wallet balance:', wallet.balance);
        throw new Error('Invalid wallet balance');
      }

      if (walletBalance < escrowHeld) {
        console.log(`Insufficient funds: balance ${walletBalance}, required ${escrowHeld}`);
        throw new Error('Insufficient funds');
      }

      // Create the order with current date and ensure advertiser ID is properly set
      let advertiserId = user.id;
      // Ensure advertiser ID is a number
      if (typeof advertiserId === 'string') {
        advertiserId = parseInt(advertiserId, 10);
        if (isNaN(advertiserId)) {
          console.error('Failed to parse advertiser ID as a number:', user.id);
          throw new Error('Invalid advertiser ID format');
        }
      }

      const orderData = {
        ...data,
        advertiser: advertiserId, // Use the properly formatted advertiser ID
        feeRate,
        platformFee,
        escrowHeld,
        orderDate: new Date(),
        orderStatus: 'pending',
      };

      // Debug log to check data format
      console.log('Creating order with data:', JSON.stringify(orderData, null, 2));

      // Use database transaction to ensure everything completes or nothing does
      const result = await strapi.db.transaction(async ({ trx }) => {
        try {
          // Ensure all required fields are available in a proper format
          if (!orderData.advertiser) {
            throw new Error('Advertiser ID is missing from order data');
          }
          
          // Convert numeric IDs to ensure proper format
          if (orderData.website && typeof orderData.website === 'string') {
            try {
              orderData.website = parseInt(orderData.website);
              if (isNaN(orderData.website)) {
                throw new Error('Invalid website ID format');
              }
            } catch (e) {
              throw new Error('Website ID must be a valid number');
            }
          }
          
          console.log('Creating order with final data:', JSON.stringify(orderData, null, 2));
          
          // Create the order using the proper format for Strapi service
          const createdOrder = await strapi.entityService.create('api::order.order', {
            data: orderData
          });

          // Verify the order was created successfully
          if (!createdOrder || !createdOrder.id) {
            throw new Error('Failed to create order record');
          }

          console.log(`Order created with ID ${createdOrder.id}, advertiser: ${createdOrder.advertiser}`);

          // Update wallet balances - subtract from balance, add to escrow
          await strapi.db.query('api::user-wallet.user-wallet').update({
            where: { id: wallet.id },
            data: {
              balance: walletBalance - escrowHeld,
              escrowBalance: (wallet.escrowBalance || 0) + escrowHeld
            }
          });

          return createdOrder;
        } catch (txError) {
          console.error('Transaction error:', txError);
          throw txError;
        }
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
