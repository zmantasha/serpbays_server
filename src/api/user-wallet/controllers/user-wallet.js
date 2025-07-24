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

      let wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      // If no wallet exists, create one automatically
      if (!wallet) {
        console.log(`No wallet found for user ${userId}, creating one automatically`);
        try {
          wallet = await strapi.entityService.create('api::user-wallet.user-wallet', {
            data: {
              users_permissions_user: userId,
              type: 'unified',
              balance: 0,
              escrowBalance: 0,
              currency: 'USD',
              publishedAt: new Date()
            }
          });
          console.log(`Created unified wallet with ID: ${wallet.id} for user ${userId}`);
        } catch (walletError) {
          console.error('Failed to create wallet:', walletError);
          return ctx.badRequest('Failed to create wallet. Please contact support.');
        }
      }

      // Calculate correct escrow balance (only pending/approved withdrawals)
      const pendingWithdrawals = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId },
          withdrawal_status: { $in: ['pending', 'approved'] }
        }
      });
      
      const correctEscrowBalance = pendingWithdrawals.reduce((total, wr) => {
        return total + parseFloat(wr.amount || 0);
      }, 0);
      
      console.log(`[getBalance] Calculated correct escrow balance: ${correctEscrowBalance} (from ${pendingWithdrawals.length} pending/approved withdrawals)`);
      
      // Update the stored escrow balance if it's different
      if (Math.abs(correctEscrowBalance - parseFloat(wallet.escrowBalance || 0)) > 0.01) {
        console.log(`[getBalance] Updating stored escrow balance from ${wallet.escrowBalance} to ${correctEscrowBalance}`);
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: wallet.id },
          data: { escrowBalance: correctEscrowBalance }
        });
      }

      return {
        data: {
          balance: wallet.balance || "0",
          escrowBalance: correctEscrowBalance.toString(),
          currency: wallet.currency || "USD"
        }
      };
    } catch (error) {
      return ctx.badRequest('Failed to get balance');
    }
  },

  // Get unified available balance (for both advertisers and publishers)
  async getAvailableBalance(ctx) {
    try {
      const userId = ctx.state?.user?.id;
      if (!userId) {
        return ctx.unauthorized('Authentication required');
      }

      // Get user's wallet (one wallet per user, regardless of role)
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }

      console.log(`[Unified] Getting available balance for user ${userId}, wallet type: ${wallet.type || 'unified'}`);

      // Base wallet balance (from direct top-ups, etc.)
      const walletBalance = parseFloat(wallet.balance || 0);
      const storedEscrowBalance = parseFloat(wallet.escrowBalance || 0);

      // Calculate earnings from completed orders (for publishers)
      let completedOrdersAmount = 0;
      let completedOrders = [];
      let transactionCount = 0;

      // Get all completed/approved orders where this user was the publisher
      const allCompletedRawOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: userId,
          orderStatus: { $in: ['approved', 'completed'] }
        }
      });
      const completedOrderIds = new Set(allCompletedRawOrders.map(order => order.id));
      console.log(`[Unified] Found ${completedOrderIds.size} completed orders where user ${userId} was publisher`);

      if (completedOrderIds.size > 0) {
        // Get 'escrow_release' transactions for completed orders
        const allEscrowReleaseTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
          filters: {
            user_wallet: { id: wallet.id },
            type: 'escrow_release',
            order: { id: { $in: Array.from(completedOrderIds) } }
          },
          populate: ['order'],
          sort: { createdAt: 'desc' }
        });

        // Deduplicate to get unique transactions per order (latest transaction per order)
        const orderTransactionMap = new Map();
        allEscrowReleaseTransactions.forEach(tx => {
          const orderId = tx.order?.id;
          if (orderId && completedOrderIds.has(orderId)) {
            if (!orderTransactionMap.has(orderId) || new Date(tx.createdAt) > new Date(orderTransactionMap.get(orderId).createdAt)) {
              orderTransactionMap.set(orderId, tx);
            }
          }
        });

        completedOrders = Array.from(orderTransactionMap.values());
        transactionCount = completedOrders.length;

        // Calculate total amount from completed orders
        completedOrdersAmount = completedOrders.reduce((total, tx) => {
          return total + parseFloat(tx.amount || 0);
        }, 0);
      }

      // Calculate actual escrow balance from pending/approved withdrawals (for publisher role)
      let withdrawalEscrowBalance = 0;
      const withdrawalsInEscrow = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId },
          withdrawal_status: { $in: ['pending', 'approved'] }
        }
      });
      withdrawalEscrowBalance = withdrawalsInEscrow.reduce((total, wr) => {
        return total + parseFloat(wr.amount || 0);
      }, 0);

      // Calculate total paid out amount (for publisher role)
      let totalPaidOutAmount = 0;
      const paidWithdrawals = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId },
          withdrawal_status: 'paid'
        }
      });
      totalPaidOutAmount = paidWithdrawals.reduce((total, wr) => {
        return total + parseFloat(wr.amount || 0);
      }, 0);

      // Calculate total available balance
      // Available = (Wallet Balance + Completed Orders - Paid Withdrawals) - Max(Stored Escrow, Withdrawal Escrow)
      const totalEarnings = walletBalance + completedOrdersAmount;
      const netRevenue = totalEarnings - totalPaidOutAmount;
      const actualEscrowBalance = Math.max(storedEscrowBalance, withdrawalEscrowBalance);
      const totalAvailable = Math.max(0, netRevenue - actualEscrowBalance);

      console.log(`[Unified] Balance calculation for user ${userId}:`, {
        walletBalance,
        completedOrdersAmount,
        totalPaidOutAmount,
        storedEscrowBalance,
        withdrawalEscrowBalance,
        actualEscrowBalance,
        totalAvailable,
        calculation: `(${walletBalance} + ${completedOrdersAmount} - ${totalPaidOutAmount}) - ${actualEscrowBalance} = ${totalAvailable}`
      });

      // Update stored escrow balance if it's significantly different (optional correction)
      if (Math.abs(actualEscrowBalance - storedEscrowBalance) > 0.01) {
        console.log(`[Unified] Correcting stored escrow balance. Was: ${storedEscrowBalance}, Now: ${actualEscrowBalance}`);
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: wallet.id },
          data: { escrowBalance: actualEscrowBalance }
        });
      }

      // Return unified response
      return {
        data: {
          balance: totalAvailable, // This is the main "available balance" everyone should use
          walletBalance, // Direct wallet balance (from top-ups)
          completedOrdersAmount, // Earnings from orders (publishers only)
          escrowBalance: actualEscrowBalance, // Amount in escrow
          totalPaidOutAmount, // Total withdrawn (publishers only)
          totalAvailable, // Same as balance, for clarity
          completedOrders, // Transaction details (publishers only)
          transactionCount, // Number of completed order transactions
          currency: wallet.currency || "USD",
          userType: wallet.type || 'unified', // wallet type or unified
          totalEarnings // Total lifetime earnings
        }
      };
    } catch (error) {
      console.error('Error getting available balance:', error);
      return ctx.badRequest('Failed to get available balance');
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

      // Get user information for display name
      // const user = await strapi.db.query('plugin::users-permissions.user').findOne({
      //   where: { id: userId }
      // });

      const data = ctx.request.body;
      data.users_permissions_user = userId;
      data.balance = "0";
      data.escrowBalance = "0";
      data.currency = data.currency || 'USD';
      // data.displayName = `${user.username || user.email || `User ${userId}`} (${data.type || 'advertiser'})`;

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
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'promo',
          amount: promoAmount,
          netAmount: promoAmount,
          currency: wallet.currency || 'USD',
          transactionStatus: 'success',
          gateway: 'promo',
          gatewayTransactionId: `PROMO_${promoCode}_${Date.now()}`,
          description: `Promo code redemption: ${promoCode}`,
          user_wallet: wallet.id,
          users_permissions_user: userId,
          fee: 0,
          metadata: {
            promoCode: promoCode,
            promoId: promo.id
          },
          publishedAt: new Date(),
          createdBy: null,
          updatedBy: null
        }
      });

      // Record promo code redemption
      const redemption = await strapi.entityService.create('api::promo-redemption.promo-redemption', {
        data: {
          promoCode: promo.id,
          user: userId,
          redeemedAt: new Date(),
          publishedAt: new Date(),
          createdBy: null,
          updatedBy: null
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
      // Return more specific error message
      return ctx.badRequest(error.message || 'Failed to redeem promo code');
    }
  },

  // Check promo code validity
  async checkPromoCode(ctx) {
    try {
      const { promoCode } = ctx.request.body;
      if (!promoCode) {
        return ctx.badRequest('Promo code is required');
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

      return {
        data: {
          valid: true,
          amount: promo.amount,
          expiryDate: promo.expiryDate
        }
      };
    } catch (error) {
      console.error('Promo code check error:', error);
      return ctx.badRequest(error.message || 'Failed to check promo code');
    }
  },

  // Migration method to fix existing completed orders
  async fixCompletedOrderEarnings(ctx) {
    try {
      console.log('Starting migration to fix completed order earnings...');
      
      // Get all completed orders
      const completedOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          orderStatus: { $in: ['approved', 'completed'] }
        },
        populate: ['publisher', 'advertiser']
      });

      console.log(`Found ${completedOrders.length} completed orders to process`);
      
      let processedCount = 0;
      let errorCount = 0;

      for (const order of completedOrders) {
        try {
          if (!order.publisher?.id) {
            console.log(`Skipping order ${order.id} - no publisher`);
            continue;
          }

          // Find publisher wallet
          let publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { users_permissions_user: order.publisher.id }
          });

          if (!publisherWallet) {
            console.log(`Creating wallet for publisher ${order.publisher.id}`);
            publisherWallet = await strapi.entityService.create('api::user-wallet.user-wallet', {
              data: {
                users_permissions_user: order.publisher.id,
                type: 'unified',
                balance: 0,
                escrowBalance: 0,
                currency: 'USD',
                status: 'active',
                publishedAt: new Date()
              },
            });
          }

          // Check if earnings already credited for this order
          const existingTransaction = await strapi.entityService.findMany('api::transaction.transaction', {
            filters: {
              user_wallet: { id: publisherWallet.id },
              type: 'escrow_release',
              order: { id: order.id },
              publishedAt: { $notNull: true }
            }
          });

          if (existingTransaction.length > 0) {
            console.log(`Order ${order.id} already has credited earnings, checking wallet balance...`);
            
            // Calculate total earnings that should be in wallet from this order
            const totalEarnings = existingTransaction.reduce((sum, tx) => sum + parseFloat(tx.amount || 0), 0);
            
            // Add to wallet if not already there (idempotent)
            await strapi.db.query('api::user-wallet.user-wallet').update({
              where: { id: publisherWallet.id },
              data: {
                balance: publisherWallet.balance + totalEarnings
              }
            });
            
            console.log(`Added ${totalEarnings} to publisher ${order.publisher.id} wallet for order ${order.id}`);
            processedCount++;
            continue;
          }

          // Credit the earnings
          const paymentAmount = order.totalAmount || 0;
          
          if (paymentAmount > 0) {
            // Add to wallet balance
            await strapi.db.query('api::user-wallet.user-wallet').update({
              where: { id: publisherWallet.id },
              data: {
                balance: publisherWallet.balance + paymentAmount
              }
            });

            // Create transaction record
            await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'escrow_release',
                amount: paymentAmount,
                netAmount: paymentAmount,
                transactionStatus: 'success',
                gateway: 'test',
                gatewayTransactionId: `migration_${order.id}_${Date.now()}`,
                description: `Migration: Payment for order #${order.id}`,
                user_wallet: publisherWallet.id,
                users_permissions_user: order.publisher.id,
                order: order.id,
                publishedAt: new Date()
              }
            });

            console.log(`Credited ${paymentAmount} to publisher ${order.publisher.id} for order ${order.id}`);
            processedCount++;
          }
        } catch (error) {
          console.error(`Error processing order ${order.id}:`, error);
          errorCount++;
        }
      }

      return ctx.send({
        success: true,
        message: `Migration completed. Processed: ${processedCount}, Errors: ${errorCount}`,
        processed: processedCount,
        errors: errorCount
      });

    } catch (error) {
      console.error('Migration error:', error);
      return ctx.badRequest('Migration failed');
    }
  }
}));