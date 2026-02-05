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
      const escrowHeld = totalAmount;

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

      // Check if user is trying to order from their own website (prevent self-ordering)
      // Check by userId (publisher relation) or email for legacy
      if (data.website && (
        (data.website.publisher && data.website.publisher === user.id) ||
        (!data.website.publisher && data.website.publisher_email === user.email)
      )) {
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

        const currentEscrow = parseFloat(currentWallet.escrowBalance) || 0;
        const newEscrowBalance = currentEscrow + escrowHeld;

        console.log(`[ORDER CREATE] Money Flow for User ${user.id}:`);
        console.log(`  - Wallet ID: ${currentWallet.id} (original: ${wallet.id})`);
        console.log(`  - Spent ${escrowHeld} using priority: Promo ${spendResult.promoSpent}, Main ${spendResult.mainSpent}`);
        console.log(`  - Adding ${escrowHeld} to escrow: ${currentWallet.escrowBalance} → ${newEscrowBalance}`);

        // Store spending breakdown in order metadata for accurate refunds
        await strapi.entityService.update('api::order.order', order.id, {
          data: {
            metadata: {
              spendingBreakdown: {
                promoSpent: spendResult.promoSpent,
                mainSpent: spendResult.mainSpent,
                totalSpent: escrowHeld
              }
            }
          }
        });

        // Update escrow balance
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: currentWallet.id },
          data: {
            escrowBalance: newEscrowBalance
          }
        });

        console.log("current", currentWallet)
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
    // ✅ CRITICAL: Use database transaction to ensure atomicity
    // All wallet operations must succeed or all fail - prevents money loss on crashes
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

      // ✅ ATOMIC OPERATION 1: Release escrow funds from advertiser wallet 
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          escrowBalance: newAdvertiserEscrow
        }
      });

      // ✅ ATOMIC OPERATION 2: Add earnings to publisher MAIN balance (withdrawable funds)
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

      // ✅ ATOMIC OPERATION 3: Create platform fee transaction
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

      // ✅ ATOMIC OPERATION 4: Update the order status
      const updatedOrder = await strapi.entityService.update('api::order.order', id, {
        data: {
          orderStatus: 'completed',
          completedDate: new Date(),
          orderAccepted: true,
          revisionStatus: null // Clear revision status when order is completed
        }
      });

      console.log(`Order ${id} completed successfully and marked available for withdrawal`);

      // ✅ Transaction committed successfully - all operations atomic
      // If any operation above fails, ALL operations are rolled back

      // Trigger TAT update for the website based on completed orders
      // NOTE: This runs AFTER transaction commits (not critical for atomicity)
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
        currentEscrow: advertiserWallet.escrowBalance,
        orderMetadata: order.metadata
      });

      // Check if we have spending breakdown from order metadata
      const spendingBreakdown = order.metadata?.spendingBreakdown;
      const refundAmount = parseFloat(order.escrowHeld);

      if (spendingBreakdown && (spendingBreakdown.promoSpent > 0 || spendingBreakdown.mainSpent > 0)) {
        console.log("Using spending breakdown for accurate refund:", spendingBreakdown);

        // Refund to the correct balance types based on original spending
        const promoRefund = parseFloat(spendingBreakdown.promoSpent || 0);
        const mainRefund = parseFloat(spendingBreakdown.mainSpent || 0);

        // Get current wallet balances
        const currentMainBalance = parseFloat(advertiserWallet.mainBalance || 0);
        const currentPromoBalance = parseFloat(advertiserWallet.promoBalance || 0);

        // Calculate new balances
        const newMainBalance = currentMainBalance + mainRefund;
        const newPromoBalance = currentPromoBalance + promoRefund;
        const newTotalBalance = newMainBalance + newPromoBalance;

        // Update wallet balances directly
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: advertiserWallet.id },
          data: {
            mainBalance: newMainBalance,
            promoBalance: newPromoBalance,
            balance: newTotalBalance
          }
        });

        // Create single consolidated refund transaction
        await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'refund',
            amount: refundAmount, // Total refund amount
            netAmount: refundAmount,
            transactionStatus: 'success',
            gateway: 'system',
            gatewayTransactionId: `refund_${order.id}_${Date.now()}`,
            fund_source: promoRefund > mainRefund ? 'promo_fund' : 'main_fund', // Use the dominant fund source
            description: `Refund for rejected order #${order.id} (${promoRefund > 0 && mainRefund > 0 ? 'mixed funds' : promoRefund > 0 ? 'promo funds' : 'main funds'})`,
            user_wallet: advertiserWallet.id,
            users_permissions_user: advertiserId,
            order: order.id,
            metadata: {
              refundBreakdown: {
                promoRefund: promoRefund,
                mainRefund: mainRefund,
                totalRefund: refundAmount
              },
              original_order: order.id
            },
            publishedAt: new Date()
          }
        });

        console.log(`Refunded ${mainRefund} to main balance and ${promoRefund} to promo balance`);
      } else {
        console.log("No spending breakdown found, using fallback refund to main balance");

        // Fallback: Refund entire amount to main balance (old behavior)
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
      }

      // Validate and reduce escrow balance
      const currentEscrow = parseFloat(advertiserWallet.escrowBalance) || 0;
      if (currentEscrow < refundAmount) {
        console.error(`[ESCROW ERROR] Cannot refund $${refundAmount}, only $${currentEscrow} in escrow!`);
        throw new Error(`Insufficient escrow balance for refund: have $${currentEscrow}, need $${refundAmount}`);
      }

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          escrowBalance: currentEscrow - refundAmount
        }
      });

      console.log("Refund transactions created successfully");

      console.log(`Order ${id} rejected and escrow refunded to correct balance types`);
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

      // Check if order is already accepted (only check status, publisher may be pre-assigned)
      if (order.orderStatus !== 'pending') {
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

      // Normal case: Verify user can accept this order using ORDER's snapshot data
      // NOT live marketplace data (which may have changed due to ownership transfer)
      // User can accept if:
      // 1. They are the directly assigned publisher on this order
      // 2. The order's snapshotted publisher email matches their email
      const isDirectPublisher = order.publisher && (order.publisher.id === user.id || order.publisher === user.id);
      const isSnapshotPublisher = order.websitePublisherEmail === user.email;

      if (!isDirectPublisher && !isSnapshotPublisher) {
        console.log(`[Accept Order] User ${user.id} (${user.email}) denied access to order ${id}`);
        console.log(`[Accept Order] Order publisher: ${order.publisher?.id}, Snapshot email: ${order.websitePublisherEmail}`);
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

        // Check using ORDER's snapshot data (not live marketplace which may have changed)
        // User can deliver if the order's snapshotted publisher email matches their email
        if (order.websitePublisherEmail === user.email) {
          console.log(`User ${user.email} matches order snapshot email. Assigning as publisher.`);
          canDeliver = true;
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
  },

  // Cancellation Helper: Validate if order can be cancelled
  async validateCancellation(order, userId, cancelledBy) {
    // System cancellations (cron jobs)
    if (cancelledBy === 'system') {
      return { allowed: true };
    }

    // Advertiser cancellation rules
    if (cancelledBy === 'advertiser') {
      if (order.advertiser.id !== userId) {
        return { allowed: false, reason: 'Not authorized to cancel this order' };
      }

      // Can cancel if not accepted yet
      if (order.orderStatus === 'pending') {
        return { allowed: true };
      }

      // Can cancel if accepted but not delivered in 7 days
      if (order.orderStatus === 'accepted' && order.acceptedDate) {
        const acceptedDate = new Date(order.acceptedDate);
        const daysSinceAccepted = (Date.now() - acceptedDate) / (1000 * 60 * 60 * 24);

        if (daysSinceAccepted >= 7) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: 'Order already accepted. Cannot cancel until 7 days after acceptance with no delivery.'
        };
      }

      return { allowed: false, reason: 'Order cannot be cancelled at this stage' };
    }

    // Publisher cancellation rules
    if (cancelledBy === 'publisher') {
      // Check if user is the direct publisher OR the website owner via ID or email
      let isPublisher = order.publisher && order.publisher.id === userId;

      if (!isPublisher && order.website) {
        // Check by publisher relation first
        if (order.website.publisher && order.website.publisher === userId) {
          isPublisher = true;
        }
        // Fallback to email for legacy records
        else if (!order.website.publisher && order.website.publisher_email) {
          const userRecord = await strapi.entityService.findOne('plugin::users-permissions.user', userId);
          if (userRecord && userRecord.email === order.website.publisher_email) {
            isPublisher = true;
          }
        }
      }

      if (!isPublisher) {
        return { allowed: false, reason: 'Not authorized to cancel this order' };
      }

      // Can cancel if accepted but not delivered
      if (order.orderStatus === 'accepted') {
        return { allowed: true };
      }

      return { allowed: false, reason: 'Order can only be cancelled after acceptance and before delivery' };
    }

    return { allowed: false, reason: 'Invalid cancellation type' };
  },

  // Cancellation Helper: Refund escrow
  async refundEscrowToAdvertiser(order) {
    // Get advertiser (buyer) wallet
    const advertiserWallet = await strapi.controller('api::user-wallet.user-wallet')
      .getOrCreateWallet(order.advertiser.id);

    const refundAmount = parseFloat(order.totalAmount);
    const currentEscrow = parseFloat(advertiserWallet.escrowBalance) || 0;

    // Validate sufficient escrow before refunding
    if (currentEscrow < refundAmount) {
      console.error(`[ESCROW ERROR] Cannot refund $${refundAmount}, only $${currentEscrow} in escrow!`);
      console.error(`[ESCROW ERROR] Order ID: ${order.id}, Advertiser ID: ${order.advertiser.id}`);
      throw new Error(`Insufficient escrow balance: have $${currentEscrow}, need $${refundAmount}`);
    }

    // Check if order has spending breakdown metadata
    const spendingBreakdown = order.metadata?.spendingBreakdown;

    if (spendingBreakdown && (spendingBreakdown.promoSpent || spendingBreakdown.mainSpent)) {
      // Refund to original sources based on spending breakdown
      const promoRefund = parseFloat(spendingBreakdown.promoSpent || 0);
      const mainRefund = parseFloat(spendingBreakdown.mainSpent || 0);

      console.log(`[Refund] Using spending breakdown: Promo $${promoRefund}, Main $${mainRefund}`);

      const currentMainBalance = parseFloat(advertiserWallet.mainBalance) || 0;
      const currentPromoBalance = parseFloat(advertiserWallet.promoBalance) || 0;
      const currentTotalBalance = parseFloat(advertiserWallet.balance) || 0;

      // Update wallet with refunds to original sources
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          mainBalance: currentMainBalance + mainRefund,
          promoBalance: currentPromoBalance + promoRefund,
          balance: currentTotalBalance + refundAmount, // Update total balance
          escrowBalance: currentEscrow - refundAmount
        }
      });

      // Create refund transactions (one for each source if both were used)
      if (promoRefund > 0) {
        await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'refund',
            amount: promoRefund,
            netAmount: promoRefund,
            transactionStatus: 'success',
            gateway: 'system',
            gatewayTransactionId: `refund_promo_${order.id}_${Date.now()}`,
            fund_source: 'promo_fund',
            description: `Refund to promo balance for cancelled order #${order.id}`,
            user_wallet: advertiserWallet.id,
            users_permissions_user: order.advertiser.id,
            order: order.id,
            publishedAt: new Date()
          }
        });
      }

      if (mainRefund > 0) {
        await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'refund',
            amount: mainRefund,
            netAmount: mainRefund,
            transactionStatus: 'success',
            gateway: 'system',
            gatewayTransactionId: `refund_main_${order.id}_${Date.now()}`,
            fund_source: 'main_fund',
            description: `Refund to main balance for cancelled order #${order.id}`,
            user_wallet: advertiserWallet.id,
            users_permissions_user: order.advertiser.id,
            order: order.id,
            publishedAt: new Date()
          }
        });
      }

      console.log(`[Refund] $${refundAmount} refunded to advertiser ${order.advertiser.id} (Promo: $${promoRefund}, Main: $${mainRefund})`);
    } else {
      // Fallback: No spending breakdown, refund to main balance only
      console.log(`[Refund] No spending breakdown found, refunding to main balance`);

      const currentMainBalance = parseFloat(advertiserWallet.mainBalance) || 0;
      const currentTotalBalance = parseFloat(advertiserWallet.balance) || 0;

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: advertiserWallet.id },
        data: {
          mainBalance: currentMainBalance + refundAmount,
          balance: currentTotalBalance + refundAmount, // Update total balance
          escrowBalance: currentEscrow - refundAmount
        }
      });

      // Create refund transaction
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'refund',
          amount: refundAmount,
          netAmount: refundAmount,
          transactionStatus: 'success',
          gateway: 'system',
          gatewayTransactionId: `refund_order_${order.id}_${Date.now()}`,
          fund_source: 'main_fund',
          description: `Refund for cancelled order #${order.id}`,
          user_wallet: advertiserWallet.id,
          users_permissions_user: order.advertiser.id,
          order: order.id,
          publishedAt: new Date()
        }
      });

      console.log(`[Refund] $${refundAmount} refunded to advertiser ${order.advertiser.id} for order ${order.id}`);
    }

    return refundAmount;
  },

  // Cancellation Helper: Create audit log
  async createAuditLog(order, action, userId, reason) {
    try {
      await strapi.entityService.create('api::order-audit-log.order-audit-log', {
        data: {
          order: order.id,
          action,
          performedBy: userId, // Can be null for system
          previousStatus: order.orderStatus,
          newStatus: action === 'cancelled' ? 'cancelled' : order.orderStatus,
          reason,
          metadata: {
            orderAmount: order.totalAmount,
            timestamp: new Date().toISOString()
          },
          timestamp: new Date(),
          publishedAt: new Date()
        }
      });
    } catch (e) {
      console.error("Failed to create audit log", e);
    }
  },

  // Cancellation Helper: Send notifications
  async sendCancellationNotifications(order, cancelledBy, reason) {
    const notificationService = strapi.service('api::notification.notification');
    const emailService = strapi.service('api::global.email-operations');

    // Email to advertiser using universal template
    try {
      if (order.advertiser.email) {
        await emailService.sendOrderCancellationEmail(
          order,
          order.advertiser.email,
          cancelledBy,
          reason
        );
        console.log(`Cancellation email sent to advertiser ${order.advertiser.email}`);
      }
    } catch (e) {
      console.error("Failed to send cancellation email to advertiser", e);
    }

    // In-app notification to advertiser
    try {
      await notificationService.createOrderNotification(
        order.id,
        order.publisher ? order.publisher.id : null,
        order.advertiser.id,
        'order_cancelled',
        {
          recipientId: order.advertiser.id,
          cancelledBy,
          reason
        }
      );
    } catch (e) {
      console.error("Failed to create notification for advertiser", e);
    }

    // Email to publisher (if exists) using universal template
    if (order.publisher) {
      try {
        if (order.publisher.email) {
          await emailService.sendOrderCancellationEmail(
            order,
            order.publisher.email,
            cancelledBy,
            reason
          );
          console.log(`Cancellation email sent to publisher ${order.publisher.email}`);
        }
      } catch (e) {
        console.error("Failed to send cancellation email to publisher", e);
      }

      // In-app notification to publisher
      try {
        await notificationService.createOrderNotification(
          order.id,
          order.publisher.id,
          order.advertiser.id,
          'order_cancelled',
          {
            recipientId: order.publisher.id,
            cancelledBy,
            reason
          }
        );
      } catch (e) {
        console.error("Failed to create notification for publisher", e);
      }
    }
  }
}));
