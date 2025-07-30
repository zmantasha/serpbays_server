'use strict';

/**
 * user-wallet controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::user-wallet.user-wallet', ({ strapi }) => ({
  
  // Centralized wallet creation - USE THIS EVERYWHERE
  async getOrCreateWallet(userId) {
    try {
      // First, ensure no duplicates exist
      await this.ensureSingleWallet(userId);
      
      // Try to find existing wallet
      let wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      // If wallet exists, return it
      if (wallet) {
        console.log(`[GetOrCreate] Found existing wallet ${wallet.id} for user ${userId}`);
        return wallet;
      }

      // Create new wallet if none exists
      console.log(`[GetOrCreate] Creating new wallet for user ${userId}`);
      wallet = await strapi.entityService.create('api::user-wallet.user-wallet', {
        data: {
          users_permissions_user: userId,
          type: 'unified',
          balance: 0,
          escrowBalance: 0,
          pendingWithdrawalBalance: 0,
          currency: 'USD',
          publishedAt: new Date()
        }
      });

      // Fix bidirectional relation for Strapi admin visibility
      try {
        await strapi.db.query('plugin::users-permissions.user').update({
          where: { id: userId },
          data: { user_wallet: wallet.id }
        });
        console.log(`[GetOrCreate] Fixed bidirectional relation for user ${userId}`);
      } catch (relationError) {
        console.error(`[GetOrCreate] Failed to fix relation for user ${userId}:`, relationError.message);
      }

      console.log(`[GetOrCreate] Created wallet ${wallet.id} for user ${userId}`);
      return wallet;
    } catch (error) {
      console.error('[GetOrCreate] Error getting/creating wallet:', error);
      throw error;
    }
  },

  // Ensure user has only one wallet (cleanup duplicates)
  async ensureSingleWallet(userId) {
    try {
      // Find all wallets for this user
      const allWallets = await strapi.db.query('api::user-wallet.user-wallet').findMany({
        where: { users_permissions_user: userId }
      });

      if (allWallets.length <= 1) {
        console.log(`[Cleanup] User ${userId} has ${allWallets.length} wallet(s) - no consolidation needed, preserving existing balances`);
        return; // 🎯 CRITICAL: Skip ALL processing to preserve escrow balance
      }

      console.log(`[Cleanup] ⚠️  Found ${allWallets.length} wallets for user ${userId}, consolidating...`);
      
      // Log current wallet states before consolidation
      allWallets.forEach((w, i) => {
        console.log(`[Cleanup] Wallet ${i + 1} (ID: ${w.id}): Balance $${w.balance}, Escrow $${w.escrowBalance}, Pending $${w.pendingWithdrawalBalance}`);
      });

      // Find the best wallet to keep (most recent or highest balance)
      const primaryWallet = allWallets.sort((a, b) => {
        // Prefer published wallets, then by update time, then by balance
        if (a.publishedAt && !b.publishedAt) return -1;
        if (!a.publishedAt && b.publishedAt) return 1;
        if (new Date(b.updatedAt) !== new Date(a.updatedAt)) {
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        }
        return parseFloat(b.balance || 0) - parseFloat(a.balance || 0);
      })[0];

      console.log(`[Cleanup] Selected primary wallet: ID ${primaryWallet.id}`);

      // Sum up balances from all wallets
      const totalBalance = allWallets.reduce((sum, w) => sum + parseFloat(w.balance || 0), 0);
      const totalEscrow = allWallets.reduce((sum, w) => sum + parseFloat(w.escrowBalance || 0), 0);
      const totalPending = allWallets.reduce((sum, w) => sum + parseFloat(w.pendingWithdrawalBalance || 0), 0);

      console.log(`[Cleanup] Consolidating: Balance $${totalBalance}, Escrow $${totalEscrow}, Pending $${totalPending}`);

      // Update the primary wallet with consolidated amounts
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: primaryWallet.id },
        data: {
          balance: totalBalance,
          escrowBalance: totalEscrow,
          pendingWithdrawalBalance: totalPending
        }
      });

      console.log(`[Cleanup] ✅ Primary wallet ${primaryWallet.id} updated with consolidated amounts`);

      // DELETE all other wallets completely (clean database)
      const otherWalletIds = allWallets.filter(w => w.id !== primaryWallet.id).map(w => w.id);
      if (otherWalletIds.length > 0) {
        await strapi.db.query('api::user-wallet.user-wallet').deleteMany({
          where: { id: { $in: otherWalletIds } }
        });
        console.log(`[Cleanup] 🗑️  DELETED ${otherWalletIds.length} duplicate wallets: ${otherWalletIds.join(', ')}`);
      }

      console.log(`[Cleanup] ✅ Consolidated and DELETED ${allWallets.length - 1} duplicate wallets. Kept wallet ${primaryWallet.id} with consolidated balances`);
    } catch (error) {
      console.error('[Cleanup] ❌ Error consolidating wallets:', error);
    }
  },

  // Override the default find method
  async find(ctx) {
    try {
      const userId = ctx.state?.user?.id;
      if (!userId) {
        return ctx.unauthorized('Authentication required');
      }

      // REMOVED: ensureSingleWallet call from find method
      // This was causing escrow balance to be reset after order creation
      // Wallet consolidation should only happen during creation, not during reads

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

      // Use centralized wallet creation
      let wallet = await this.getOrCreateWallet(userId);

      // 🎯 FIXED: Don't recalculate escrow balance in getBalance!
      // Escrow balance should only be managed by order creation/completion logic
      // This method was incorrectly calculating escrow from withdrawals instead of orders
      
      console.log(`[getBalance] Current escrow balance: ${wallet.escrowBalance} (preserved from order logic)`);

      return {
        data: {
          balance: wallet.balance || "0",
          escrowBalance: wallet.escrowBalance.toString(), // ✅ Use actual escrow balance
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

      // Use centralized wallet creation
      let wallet = await this.getOrCreateWallet(userId);

       console.log(`[Simple] Getting balance for user ${userId}, wallet ID: ${wallet.id}, balance: ${wallet.balance}`);

       // Use simple wallet balances directly (no complex calculations)
       const walletBalance = parseFloat(wallet.balance || 0);
       const storedEscrowBalance = parseFloat(wallet.escrowBalance || 0);
       const pendingWithdrawalBalance = parseFloat(wallet.pendingWithdrawalBalance || 0);

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

               // Note: pendingWithdrawalBalance already declared above

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

      // Calculate total available balance (Available Balance = Wallet Balance)
      // Pending withdrawals are already deducted from wallet balance when withdrawal request is created
      const totalAvailable = walletBalance;

      console.log(`[Simple] Balance calculation for user ${userId}:`, {
        walletBalance,
        storedEscrowBalance,
        pendingWithdrawalBalance,
        totalAvailable,
        calculation: `Available Balance = Wallet Balance = ${totalAvailable}`,
        note: 'Available balance equals wallet balance (pending withdrawals already deducted)'
      });

      // Note: escrowBalance is kept separate for order processing, 
      // pendingWithdrawalBalance is managed directly by withdrawal operations

      // Return simplified response
      return {
        data: {
          balance: totalAvailable, // Available for spending/withdrawal
          walletBalance, // Total wallet balance
          escrowBalance: storedEscrowBalance, // Amount held in escrow for active orders
          pendingWithdrawalBalance, // Amount pending withdrawal
          totalAvailable, // Same as balance, for clarity
          currency: wallet.currency || "USD",
          userType: wallet.type || 'unified'
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

      // Use centralized wallet creation (will check for existing wallet)
      const wallet = await this.getOrCreateWallet(userId);

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

      // Use centralized wallet creation - create wallet if it doesn't exist
      const wallet = await this.getOrCreateWallet(userId);
      console.log(`[PROMO REDEMPTION] Got/created wallet ${wallet.id} for user ${userId}`);

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

      console.log(`[PROMO] Updating balance for user ${userId}: ${currentBalance} + ${promoAmount} = ${newBalance}`);

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: wallet.id },
        data: {
          balance: newBalance  // ✅ Store as number, not string
        }
      });

      console.log(`[PROMO] Balance updated successfully for wallet ${wallet.id}`);

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

          // Use centralized wallet creation for publisher
          let publisherWallet = await this.getOrCreateWallet(order.publisher.id);

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

