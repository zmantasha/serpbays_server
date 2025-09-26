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

      // Get user wallet - unified wallet works for both advertiser and publisher
      let wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: user.id
        },
        populate: ['users_permissions_user']
      });

      // Use centralized wallet creation
      if (!wallet) {
        console.log(`No advertiser wallet found for user ${user.id}, creating one automatically`);
        try {
          wallet = await strapi.controller('api::user-wallet.user-wallet').getOrCreateWallet(user.id);
          console.log(`Got/created advertiser wallet with ID: ${wallet.id} for user ${user.id}`);
        } catch (walletError) {
          console.error('Failed to get/create advertiser wallet:', walletError);
          throw new Error('Failed to get/create advertiser wallet. Please contact support.');
        }
      }

      // Calculate fee
      const totalAmount = parseFloat(data.totalAmount);
      const escrowHeld = totalAmount ;

      // Refresh wallet balance to check current funds
      const freshWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: wallet.id }
      });
      
      // Check if user has sufficient balance (using separate balance tracking)
      const totalBalance = parseFloat(freshWallet.balance || 0);
      const mainBalance = parseFloat(freshWallet.mainBalance || 0);
      const promoBalance = parseFloat(freshWallet.promoBalance || 0);
      
      if (!freshWallet || totalBalance < escrowHeld) {
        throw new Error(`Insufficient funds. Available: ${totalBalance}, Required: ${escrowHeld}`);
      }
      
      console.log('Balance check for order:', {
        totalBalance,
        mainBalance,
        promoBalance,
        escrowHeld
      });

      // Check if user is trying to order from their own website
      if (data.website && data.website.publisher_email === user.email) {
        throw new Error('You cannot order from your own website. This is not allowed to prevent self-ordering issues.');
      }

      // Create the order with current date
      const orderData = {
        ...data,
        advertiser: user.id,
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
    
        // Refresh wallet data to ensure current balances before money transfer
        const currentWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: wallet.id }
        });
        
        if (!currentWallet) {
          throw new Error('Wallet not found during money transfer');
        }
    
        // MONEY FLOW: Use spending priority (promo funds first, then main funds) → Advertiser Escrow
        const spendResult = await strapi.controller('api::user-wallet.user-wallet').spendFunds(
          user.id,
          escrowHeld,
          order.id,
          { description: `Order #${order.id} escrow hold` }
        );
        
        const newEscrowBalance = currentWallet.escrowBalance + escrowHeld;
        
        console.log(`[ORDER CREATE] Money Flow for User ${user.id}:`);
        console.log(`  - Wallet ID: ${currentWallet.id} (original: ${wallet.id})`);
        console.log(`  - Spent ${escrowHeld} using priority: Promo ${spendResult.promoSpent}, Main ${spendResult.mainSpent}`);
        console.log(`  - Adding ${escrowHeld} to escrow: ${currentWallet.escrowBalance} → ${newEscrowBalance}`);
        
        // Update escrow balance
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: currentWallet.id },
          data: {
            escrowBalance: newEscrowBalance
          }
        });
        
        console.log("current",currentWallet)
        // Verify the update worked
        const verifyWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: currentWallet.id }
        });
        
        console.log(`[ORDER CREATE] ✅ Wallet updated successfully for order ${order.id}`);
        console.log(`[ORDER CREATE] ✅ Verified - Balance: ${verifyWallet.balance}, Escrow: ${verifyWallet.escrowBalance}`);

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
      
      // Get advertiser and publisher wallets (unified system - one wallet per user)
      const advertiserWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: advertiserId
        }
      });
      
      if (!advertiserWallet) {
        throw new Error('Advertiser wallet not found');
      }
      
      // Use centralized wallet creation for publisher
      let publisherWallet = await strapi.controller('api::user-wallet.user-wallet').getOrCreateWallet(publisherId);
      console.log(`Got/created publisher wallet with ID: ${publisherWallet.id}`);
      
      // Calculate payment amount (without platform fee)
      const paymentAmount = order.totalAmount;
      
      // MONEY FLOW: Advertiser Escrow → Publisher MAIN Balance (earnings are withdrawable)
      const newAdvertiserEscrow = advertiserWallet.escrowBalance - order.escrowHeld;
      
      console.log(`[ORDER COMPLETE] Money Flow for Order ${order.id}:`);
      console.log(`  - Advertiser ${order.advertiser.id}: Escrow ${advertiserWallet.escrowBalance} → ${newAdvertiserEscrow}`);
      console.log(`  - Publisher ${publisherId}: Adding ${paymentAmount} to MAIN balance (withdrawable)`);
      console.log(`  - Amount transferred: ${paymentAmount}`);
      
      // Release escrow funds from advertiser wallet 
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          escrowBalance: newAdvertiserEscrow
        }
      });

      // Add earnings to publisher MAIN balance (withdrawable funds)
      await strapi.controller('api::user-wallet.user-wallet').addMainFunds(
        publisherId,
        paymentAmount,
        {
          description: `Earnings from order #${order.id}`,
          gateway: 'system',
          gatewayTransactionId: `earnings_${order.id}_${Date.now()}`
        }
      );
      
      console.log(`[ORDER COMPLETE] ✅ Money transfer completed successfully`);
      
      // Create platform fee transaction
      const feeTransaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'fee',
          amount: 0, // Since fee is 0
          netAmount: 0, // Since fee is 0
          fee: 0,
          transactionStatus: 'success',
          gateway: 'system',
          gatewayTransactionId: `fee_${order.id}_${Date.now()}`,
          description: `Platform fee for order #${order.id}`,
          // This would go to the platform wallet in a production system
          users_permissions_user: publisherId,
          order: order.id,
          publishedAt: new Date()
        }
      });
      
      console.log("Created fee transaction:", {
        feeTransactionId: feeTransaction.id
      });
      
      // Update the order
      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: {
          orderStatus: 'completed',
          completedDate: new Date(),
          orderAccepted: true,
          revisionStatus: null // Clear revision status when order is completed
        }
      });
      
      console.log(`Order ${id} completed successfully and marked available for withdrawal`);
      
      // Trigger TAT update for the website based on completed orders
      try {
        const websiteId = order.website?.id || order.website;
        if (websiteId) {
          // Don't await this to avoid blocking the order completion
          // The TAT update will run in the background
          strapi.service('api::marketplace.marketplace').updateTATFromCompletedOrders(websiteId, {
              minOrderCount: 1, // Lower threshold for testing
              lookbackDays: 365,
              useWeightedAverage: true
            })
            .then(result => {
              if (result) {
                console.log(`TAT updated for website ${websiteId}: ${result.newTAT} days (${result.placementSpeed})`);
              } else {
                console.log(`TAT update skipped for website ${websiteId}: insufficient order history`);
              }
            })
            .catch(error => {
              console.error(`Failed to update TAT for website ${websiteId}:`, error);
            });
        }
      } catch (error) {
        console.error('Error triggering TAT update:', error);
        // Don't fail the order completion if TAT update fails
      }
      
      return updatedOrder;
    });
  },

  // When an order is rejected, refund escrow to advertiser
  async rejectOrder(id, user) {
    // Use transaction to ensure data consistency
    return await strapi.db.transaction(async ({ trx }) => {
      // Get the order with all relations
      const order = await this.getCompleteOrder(id);
      console.log("Processing order rejection:", { 
        orderId: id, 
        status: order.orderStatus, 
        escrowHeld: order.escrowHeld 
      });
      
      if (!order) {
        throw new Error('Order not found');
      }
      
      if (order.orderStatus !== 'pending') {
        throw new Error('Only pending orders can be rejected');
      }
      
      // Get advertiser ID (handling both object and direct ID references)
      const advertiserId = order.advertiser.id || order.advertiser;
      
      console.log("Getting advertiser wallet for:", { advertiserId });
      
      // Get advertiser wallet - unified wallet works for both roles
      const advertiserWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: advertiserId
        }
      });
      
      if (!advertiserWallet) {
        throw new Error('Advertiser wallet not found');
      }
      
      console.log("Refunding escrow:", {
        escrowHeld: order.escrowHeld,
        currentBalance: advertiserWallet.balance,
        currentEscrow: advertiserWallet.escrowBalance
      });
      
      // Refund escrow funds back to advertiser MAIN balance (since escrow was held from main/promo spending)
      const refundAmount = parseFloat(order.escrowHeld);
      const result = await strapi.controller('api::user-wallet.user-wallet').addMainFunds(
        advertiserId,
        refundAmount,
        { 
          type: 'refund',
          description: `Refund for rejected order #${order.id}`,
          gateway: 'system',
          gatewayTransactionId: `refund_${order.id}_${Date.now()}`
        }
      );
      
      // Reduce escrow balance
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          escrowBalance: advertiserWallet.escrowBalance - refundAmount
        }
      });
      
      console.log("Refund transaction created via addMainFunds method");
      
      console.log(`Order ${id} rejected and escrow refunded successfully`);
      return order;
    });
  },

  // When an order is accepted by a publisher
  async acceptOrder(id, user) {
    try {
      // Get the order with all relations
      const order = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });
      
      if (!order) {
        throw new Error('Order not found');
      }

      // Check if order is already accepted
      if (order.orderStatus !== 'pending' || order.publisher) {
        throw new Error('Order is already accepted or not available');
      }

      // Special case: If the user is the advertiser for this order, allow them to accept it themselves
      if (order.advertiser?.id === user.id || order.advertiser === user.id) {
        console.log('User is accepting their own order as both advertiser and publisher');
        
        // Update the order
        await strapi.entityService.update('api::order.order', id, {
          data: {
            publisher: user.id,
            orderStatus: 'accepted',
            acceptedDate: new Date()
          }
        });

        // Return the order with populated relations
        const updatedOrder = await strapi.entityService.findOne('api::order.order', id, {
          populate: ['advertiser', 'publisher', 'website'],
        });
        
        return updatedOrder;
      }

      // Normal case: Verify the publisher owns this website
      const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
        where: { id: order.website.id, publisher_email: user.email }
      });

      if (!isWebsiteOwner) {
        throw new Error('You do not have permission to accept this order');
      }

      // Update the order
      await strapi.entityService.update('api::order.order', id, {
        data: {
          publisher: user.id,
          orderStatus: 'accepted',
          acceptedDate: new Date()
        }
      });

      // Return the order with populated relations
      const updatedOrder = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });

      console.log(`Order ${id} accepted successfully by publisher ${user.id}`);
      console.log(`Returning order with advertiser:`, updatedOrder.advertiser);
      return updatedOrder;
    } catch (error) {
      console.error('Order acceptance failed:', error);
      throw error;
    }
  },

  // When an order is delivered by a publisher
  async deliverOrder(id, user, deliveryData = {}) {
    try {
      // Get the order with all relations
      const order = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });
      
      if (!order) {
        throw new Error('Order not found');
      }

      // Check if order is in accepted status
      if (order.orderStatus !== 'accepted') {
        throw new Error('Only accepted orders can be marked as delivered');
      }

      // Check if the order has a publisher assigned
      if (!order.publisher || !order.publisher.id) {
        // If no publisher assigned, check if current user can be assigned
        let canDeliver = false;
        
        // If the order is for a website owned by this user
        if (order.website && order.website.id) {
          const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { id: order.website.id, publisher_email: user.email }
          });
          
          if (isWebsiteOwner) {
            console.log('User owns this website. Assigning as publisher.');
            canDeliver = true;
          }
        }
        
        // Or if they are the advertiser for their own order
        if (order.advertiser && (order.advertiser.id === user.id || order.advertiser === user.id)) {
          console.log('User is the advertiser for this order. Assigning as publisher too.');
          canDeliver = true;
        }
        
        if (!canDeliver) {
          throw new Error('You do not have permission to deliver this order');
        }
        
        // Update the order to set the user as the publisher
        await strapi.entityService.update('api::order.order', id, {
          data: {
            publisher: user.id
          }
        });
        
        // Set the publisher value in our order object
        order.publisher = { id: user.id };
      } else {
        // Check if current user is the assigned publisher
        if (order.publisher.id !== user.id) {
          throw new Error('You are not the assigned publisher for this order');
        }
      }

      // Update with delivery proof if provided
      const updateData = {
        orderStatus: 'delivered',
        deliveryProof: deliveryData.proof || order.deliveryProof,
        deliveredDate: new Date()
      };
      
      // Update the order
      await strapi.entityService.update('api::order.order', id, {
        data: updateData,
      });

      // Return the order with populated relations
      const updatedOrder = await strapi.entityService.findOne('api::order.order', id, {
        populate: ['advertiser', 'publisher', 'website'],
      });

      console.log(`Order ${id} delivered successfully by publisher ${user.id}`);
      console.log(`Returning order with advertiser:`, updatedOrder.advertiser);
      return updatedOrder;
    } catch (error) {
      console.error('Order delivery failed:', error);
      throw error;
    }
  }
}));
