'use strict';

/**
 * user-wallet controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::user-wallet.user-wallet', ({ strapi }) => ({

  // Centralized wallet creation - USE THIS EVERYWHERE
  async getOrCreateWallet(userId, transaction = null) {
    try {
      const queryOptions = transaction ? { transacting: transaction } : {};

      // First, ensure no duplicates exist
      await this.ensureSingleWallet(userId, transaction);

      // Try to find existing wallet
      let wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      }, queryOptions);

      // If wallet exists, return it
      if (wallet) {
        console.log(`[GetOrCreate] Found existing wallet ${wallet.id} for user ${userId}`);
        return wallet;
      }

      // Create new wallet if none exists
      console.log(`[GetOrCreate] Creating new wallet for user ${userId}`);
      wallet = await strapi.db.query('api::user-wallet.user-wallet').create({
        data: {
          users_permissions_user: userId,
          type: 'unified',
          balance: 0,
          mainBalance: 0,
          promoBalance: 0,
          escrowBalance: 0,
          pendingWithdrawalBalance: 0,
          currency: 'USD',
          publishedAt: new Date()
        }
      }, queryOptions);

      // Fix bidirectional relation for Strapi admin visibility
      try {
        await strapi.db.query('plugin::users-permissions.user').update({
          where: { id: userId },
          data: { user_wallet: wallet.id }
        }, queryOptions);
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
  async ensureSingleWallet(userId, transaction = null) {
    try {
      const queryOptions = transaction ? { transacting: transaction } : {};

      // Find all wallets for this user
      const allWallets = await strapi.db.query('api::user-wallet.user-wallet').findMany({
        where: { users_permissions_user: userId }
      }, queryOptions);

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
      }, queryOptions);

      console.log(`[Cleanup] ✅ Primary wallet ${primaryWallet.id} updated with consolidated amounts`);

      // DELETE all other wallets completely (clean database)
      const otherWalletIds = allWallets.filter(w => w.id !== primaryWallet.id).map(w => w.id);
      if (otherWalletIds.length > 0) {
        await strapi.db.query('api::user-wallet.user-wallet').deleteMany({
          where: { id: { $in: otherWalletIds } }
        }, queryOptions);
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

      // Calculate total balance correctly (mainBalance + promoBalance)
      const mainBalance = parseFloat(wallet.mainBalance || 0);
      const promoBalance = parseFloat(wallet.promoBalance || 0);
      const totalBalance = mainBalance + promoBalance;

      return {
        data: {
          balance: totalBalance, // Return calculated total balance for transaction history
          mainBalance: mainBalance,
          promoBalance: promoBalance,
          escrowBalance: parseFloat(wallet.escrowBalance || 0), // ✅ Return as number, not string
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

      // Use separate balance tracking - only mainBalance is withdrawable
      const mainBalance = parseFloat(wallet.mainBalance || 0);
      const promoBalance = parseFloat(wallet.promoBalance || 0);
      const storedEscrowBalance = parseFloat(wallet.escrowBalance || 0);
      const pendingWithdrawalBalance = parseFloat(wallet.pendingWithdrawalBalance || 0);

      // Calculate total balance correctly (mainBalance + promoBalance)
      const totalBalance = mainBalance + promoBalance;

      // Available balance = mainBalance - pendingWithdrawalBalance (only main balance can be withdrawn)
      const walletBalance = mainBalance;

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
        mainBalance,
        promoBalance,
        totalBalance,
        walletBalance: 'mainBalance only (withdrawable)',
        storedEscrowBalance,
        pendingWithdrawalBalance,
        totalAvailable,
        calculation: `Available Balance = Main Balance - Pending Withdrawals = ${totalAvailable}`,
        note: `Main balance: ${mainBalance}, Promo balance: ${promoBalance}, Total: ${totalBalance}, Available for withdrawal: ${totalAvailable}`
      });

      // Note: escrowBalance is kept separate for order processing, 
      // pendingWithdrawalBalance is managed directly by withdrawal operations

      // Return simplified response with earnings data
      return {
        data: {
          balance: totalBalance, // Total balance (mainBalance + promoBalance) for transaction history
          walletBalance, // Available for spending/withdrawal (mainBalance only)
          totalBalance, // Total balance (mainBalance + promoBalance)
          mainBalance, // Withdrawable funds
          promoBalance, // Non-withdrawable funds
          escrowBalance: storedEscrowBalance, // Amount held in escrow for active orders
          pendingWithdrawalBalance, // Amount pending withdrawal
          totalAvailable, // Same as walletBalance, for clarity
          currency: wallet.currency || "USD",
          userType: wallet.type || 'unified',
          // Earnings data (calculated above but was missing from response)
          completedOrders, // Array of escrow_release transactions for completed orders
          completedOrdersAmount, // Total earnings from completed orders
          transactionCount, // Number of completed order transactions
          totalPaidOutAmount, // Total amount withdrawn (paid withdrawals)
          totalEarnings: completedOrdersAmount // Total lifetime earnings
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

      // Get pagination parameters
      const { page = 1, pageSize = 10 } = ctx.query;
      const limit = parseInt(pageSize);
      const offset = (parseInt(page) - 1) * limit;

      // Get transactions with pagination
      const [transactions, total] = await strapi.db.query('api::transaction.transaction').findWithCount({
        where: { user_wallet: wallet.id },
        orderBy: { createdAt: 'DESC' },
        populate: ['invoice', 'order'],
        limit,
        offset
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

      return {
        data: transformedTransactions,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: limit,
            pageCount: Math.ceil(total / limit),
            total
          }
        }
      };
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

  // Redeem promo code or voucher code
  async redeemPromo(ctx) {
    const transaction = await strapi.db.transaction();
    const queryOptions = { transacting: transaction };

    try {
      const userId = ctx.state?.user?.id;
      if (!userId) {
        await transaction.rollback();
        return ctx.unauthorized('Authentication required');
      }

      const { promoCode } = ctx.request.body;
      if (!promoCode) {
        await transaction.rollback();
        return ctx.badRequest('Promo code is required');
      }

      // Use centralized wallet creation - create wallet if it doesn't exist
      // PASS TRANSACTION to prevent deadlock
      const wallet = await this.getOrCreateWallet(userId, transaction);
      console.log(`[PROMO/VOUCHER REDEMPTION] Got/created wallet ${wallet.id} for user ${userId}`);

      let codeType = 'promo';
      let codeData = null;
      let isVoucher = false;

      // First, try to find a promo code (with row-level locking via Knex)
      // Strapi 5 keeps draft + published rows; only match published_at IS NOT NULL
      const knex = strapi.db.connection;
      const promoRows = await knex('promo_codes')
        .where('code', promoCode)
        .where('promo_status', 'active')
        .where('expiry_date', '>', new Date())
        .whereNotNull('published_at')
        .forUpdate()
        .transacting(transaction);

      if (promoRows.length > 0) {
        const row = promoRows[0];
        codeData = {
          id: row.id,
          documentId: row.document_id,
          code: row.code,
          amount: row.amount,
          promoStatus: row.promo_status,
          expiryDate: row.expiry_date,
          currentRedemptions: row.current_redemptions,
          maxRedemptions: row.max_redemptions,
        };
        codeType = 'promo';
        console.log(`[PROMO] Found promo code: ${promoCode}, id: ${codeData.id}, docId: ${codeData.documentId}, amount: $${codeData.amount}`);
      } else {
        // If not a promo code, try to find a voucher code (with row-level locking)
        const voucherRows = await knex('voucher_codes')
          .where('code', promoCode)
          .where('voucher_status', 'active')
          .where('expiry_date', '>', new Date())
          .whereNotNull('published_at')
          .forUpdate()
          .transacting(transaction);

        if (voucherRows.length > 0) {
          const row = voucherRows[0];
          codeData = {
            id: row.id,
            documentId: row.document_id,
            code: row.code,
            amount: row.amount,
            voucherStatus: row.voucher_status,
            expiryDate: row.expiry_date,
            usedBy: row.used_by,
          };
          codeType = 'voucher';
          isVoucher = true;
          console.log(`[VOUCHER] Found voucher code: ${promoCode}, id: ${codeData.id}, docId: ${codeData.documentId}, amount: $${codeData.amount}`);
        } else {
          await transaction.rollback();
          return ctx.badRequest('Invalid or expired code');
        }
      }

      if (!codeData) {
        await transaction.rollback();
        return ctx.badRequest('Invalid or expired code');
      }

      // CRITICAL: Validate usage BEFORE making any changes
      if (isVoucher) {
        // For voucher codes, check if they've already been used
        if (codeData.voucherStatus === 'used' || codeData.usedBy) {
          await transaction.rollback();
          return ctx.badRequest('This voucher code has already been used');
        }

        // Double-check with a fresh query to prevent race conditions
        const freshVoucher = await strapi.db.query('api::voucher-code.voucher-code').findOne({
          where: {
            id: codeData.id,
            voucherStatus: 'active'
          }
        }, queryOptions);

        if (!freshVoucher || freshVoucher.usedBy) {
          await transaction.rollback();
          return ctx.badRequest('This voucher code has already been used');
        }
      } else {
        // For promo codes, check if user has already used this promo code (with row-level locking)
        // Match by document_id to catch redemptions against both draft & published rows
        const allPromoRowIds = await knex('promo_codes')
          .where('document_id', codeData.documentId)
          .select('id')
          .transacting(transaction);
        const promoIdList = allPromoRowIds.map(r => r.id);

        const existingRedemptions = await knex('promo_redemptions')
          .join('promo_redemptions_promo_code_lnk', 'promo_redemptions.id', 'promo_redemptions_promo_code_lnk.promo_redemption_id')
          .join('promo_redemptions_user_lnk', 'promo_redemptions.id', 'promo_redemptions_user_lnk.promo_redemption_id')
          .whereIn('promo_redemptions_promo_code_lnk.promo_code_id', promoIdList)
          .where('promo_redemptions_user_lnk.user_id', userId)
          .forUpdate()
          .transacting(transaction);

        if (existingRedemptions.length > 0) {
          await transaction.rollback();
          return ctx.badRequest('You have already used this promo code');
        }

        // Check if promo code has reached its redemption limit
        if (codeData.currentRedemptions >= codeData.maxRedemptions) {
          await transaction.rollback();
          return ctx.badRequest('This promo code has reached its usage limit');
        }
      }

      // Now that validation passed, proceed with the transaction
      const codeAmount = parseFloat(codeData.amount) || 0;

      // Use the separate balance tracking system
      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      const currentTotalBalance = parseFloat(wallet.balance || 0);

      // Add to promo balance (both promo codes and vouchers go to promo balance)
      const newPromoBalance = currentPromoBalance + codeAmount;
      const newTotalBalance = currentMainBalance + newPromoBalance;

      console.log(`[${codeType.toUpperCase()}] Updating balances for user ${userId}:`);
      console.log(`  Main: $${currentMainBalance} (unchanged)`);
      console.log(`  Promo: $${currentPromoBalance} + $${codeAmount} = $${newPromoBalance}`);
      console.log(`  Total: $${currentTotalBalance} + $${codeAmount} = $${newTotalBalance}`);

      // Update wallet balances using separate balance tracking
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: wallet.id },
        data: {
          mainBalance: currentMainBalance,
          promoBalance: newPromoBalance,
          balance: newTotalBalance
        }
      }, queryOptions);

      console.log(`[${codeType.toUpperCase()}] Balances updated successfully for wallet ${wallet.id}`);

      // Create transaction record
      await strapi.db.query('api::transaction.transaction').create({
        data: {
          type: codeType === 'voucher' ? 'promo' : codeType, // Use 'promo' type for both voucher and promo codes
          amount: codeAmount,
          netAmount: codeAmount,
          transactionStatus: 'success',
          gateway: 'promo', // Use 'promo' gateway for both voucher and promo codes
          gatewayTransactionId: `${codeType.toUpperCase()}_${promoCode}_${Date.now()}`,
          fund_source: 'promo_fund', // Set fund source for proper tracking
          description: `${codeType === 'voucher' ? 'Voucher' : 'Promo'} code redemption: ${promoCode}`,
          user_wallet: wallet.id,
          users_permissions_user: userId,
          fee: 0,
          metadata: {
            promoCode: promoCode,
            promoId: codeData.id,
            codeType: codeType, // Store the actual code type in metadata
            currency: wallet.currency || 'USD' // Store currency in metadata instead
          },
          publishedAt: new Date(),
          createdBy: null,
          updatedBy: null
        }
      }, queryOptions);

      if (isVoucher) {
        // Mark voucher code as used
        await strapi.db.query('api::voucher-code.voucher-code').update({
          where: { id: codeData.id },
          data: {
            voucherStatus: 'used',
            usedBy: userId,
            usedAt: new Date()
          }
        }, queryOptions);
        console.log(`[VOUCHER] Marked voucher code ${promoCode} as used by user ${userId}`);

        // For vouchers, we don't create a promo-redemption record since it's for promo codes only
        // The voucher usage is tracked directly in the voucher-code table
      } else {
        // Record promo code redemption
        await strapi.db.query('api::promo-redemption.promo-redemption').create({
          data: {
            promoCode: codeData.id,
            user: userId,
            redeemedAt: new Date(),
            publishedAt: new Date(),
            createdBy: null,
            updatedBy: null
          }
        }, queryOptions);

        // Update the promo code's current redemptions count
        await strapi.db.query('api::promo-code.promo-code').update({
          where: { id: codeData.id },
          data: {
            currentRedemptions: codeData.currentRedemptions + 1
          }
        }, queryOptions);
        console.log(`[PROMO] Updated redemption count for promo code ${promoCode}: ${codeData.currentRedemptions + 1}/${codeData.maxRedemptions}`);
      }

      // Commit the transaction
      await transaction.commit();

      return {
        data: {
          amount: codeAmount,
          codeType: codeType,
          message: `Successfully redeemed ${codeType === 'voucher' ? 'voucher' : 'promo'} code for $${codeAmount}`
        }
      };
    } catch (error) {
      console.error('Promo/Voucher redemption error:', error);
      await transaction.rollback();
      // Catch the DB trigger duplicate error
      if (error.message && error.message.includes('Duplicate promo redemption')) {
        return ctx.badRequest('You have already used this promo code');
      }
      return ctx.badRequest(error.message || 'Failed to redeem code');
    }
  },

  // Check promo code or voucher code validity
  async checkPromoCode(ctx) {
    try {
      const { promoCode } = ctx.request.body;
      if (!promoCode) {
        return ctx.badRequest('Promo code is required');
      }

      let codeData = null;
      let codeType = 'promo';

      // First, try to find a promo code
      const promo = await strapi.db.query('api::promo-code.promo-code').findOne({
        where: {
          code: promoCode,
          promoStatus: 'active',
          expiryDate: {
            $gt: new Date()
          }
        }
      });

      if (promo) {
        codeData = promo;
        codeType = 'promo';
      } else {
        // If not a promo code, try to find a voucher code
        const voucher = await strapi.db.query('api::voucher-code.voucher-code').findOne({
          where: {
            code: promoCode,
            voucherStatus: 'active',
            expiryDate: {
              $gt: new Date()
            }
          }
        });

        if (voucher) {
          codeData = voucher;
          codeType = 'voucher';
        }
      }

      if (!codeData) {
        return ctx.badRequest('Invalid or expired code');
      }

      return {
        data: {
          valid: true,
          codeType: codeType,
          amount: codeData.amount,
          expiryDate: codeData.expiryDate
        }
      };
    } catch (error) {
      console.error('Promo/Voucher code check error:', error);
      return ctx.badRequest(error.message || 'Failed to check code');
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
                gateway: 'system',
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
  },

  // Add funds to main balance (from direct payments)
  async addMainFunds(userId, amount, transactionData = {}) {
    try {
      const wallet = await this.getOrCreateWallet(userId);
      const newMainBalance = parseFloat(wallet.mainBalance || 0) + parseFloat(amount);
      const newTotalBalance = parseFloat(wallet.balance || 0) + parseFloat(amount);

      await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
        data: {
          mainBalance: newMainBalance,
          balance: newTotalBalance
        }
      });

      // Determine transaction type based on context
      const transactionType = transactionData.type || 'deposit';
      // Create transaction record
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: transactionType,
          amount: parseFloat(amount),
          netAmount: parseFloat(amount),
          transactionStatus: 'success',
          gateway: transactionData.gateway || 'system',
          gatewayTransactionId: transactionData.gatewayTransactionId || `main_${Date.now()}`,
          fund_source: 'main_fund',
          description: transactionData.description || (transactionType === 'refund' ? 'Refund to main balance' : 'Direct payment deposit'),
          user_wallet: wallet.id,
          users_permissions_user: userId,
          order: transactionData.order || null, // ✅ Link to order if provided
          metadata: transactionData.metadata,
          publishedAt: new Date()
        }
      });

      console.log(`Added ${amount} to main balance for user ${userId}`);
      return { success: true, newMainBalance, newTotalBalance };
    } catch (error) {
      console.error('Error adding main funds:', error);
      throw error;
    }
  },

  // Public wrapper for adding funds
  async addFunds(ctx) {
    try {
      const userId = ctx.state.user.id;
      const { amount, paymentMethod, transactionId } = ctx.request.body;

      if (!amount || amount <= 0) {
        return ctx.badRequest('Invalid amount');
      }

      const result = await this.addMainFunds(userId, amount, {
        gateway: paymentMethod || 'manual',
        gatewayTransactionId: transactionId,
        description: `Added funds via ${paymentMethod}`
      });

      return { data: result };
    } catch (error) {
      console.error('Error in addFunds:', error);
      return ctx.badRequest('Failed to add funds');
    }
  },

  // Add funds to promo balance (from vouchers/promo codes)
  async addPromoFunds(userId, amount, promoCodeId = null, transactionData = {}) {
    try {
      const wallet = await this.getOrCreateWallet(userId);
      const newPromoBalance = parseFloat(wallet.promoBalance || 0) + parseFloat(amount);
      const newTotalBalance = parseFloat(wallet.balance || 0) + parseFloat(amount);

      await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
        data: {
          promoBalance: newPromoBalance,
          balance: newTotalBalance
        }
      });

      // Create transaction record
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'promo',
          amount: parseFloat(amount),
          netAmount: parseFloat(amount),
          transactionStatus: 'success',
          gateway: 'promo',
          gatewayTransactionId: `promo_${Date.now()}`,
          fund_source: 'promo_fund',
          promo_code_id: promoCodeId,
          description: transactionData.description || 'Promo code/voucher deposit',
          user_wallet: wallet.id,
          users_permissions_user: userId,
          metadata: transactionData.metadata,
          publishedAt: new Date()
        }
      });

      console.log(`Added ${amount} to promo balance for user ${userId}`);
      return { success: true, newPromoBalance, newTotalBalance };
    } catch (error) {
      console.error('Error adding promo funds:', error);
      throw error;
    }
  },

  // Spend funds with priority (promo first, then main)
  async spendFunds(userId, amount, orderId = null, transactionData = {}) {
    try {
      const wallet = await this.getOrCreateWallet(userId);
      const spendAmount = parseFloat(amount);
      const currentMainBalance = parseFloat(wallet.mainBalance || 0);
      const currentPromoBalance = parseFloat(wallet.promoBalance || 0);
      const totalAvailable = currentMainBalance + currentPromoBalance;

      if (totalAvailable < spendAmount) {
        throw new Error(`Insufficient funds. Available: ${totalAvailable}, Required: ${spendAmount}`);
      }

      let remainingToSpend = spendAmount;
      let promoSpent = 0;
      let mainSpent = 0;

      // Spend from promo balance first
      if (remainingToSpend > 0 && currentPromoBalance > 0) {
        promoSpent = Math.min(remainingToSpend, currentPromoBalance);
        remainingToSpend -= promoSpent;
      }

      // Spend from main balance if needed
      if (remainingToSpend > 0) {
        mainSpent = remainingToSpend;
      }

      // Update wallet balances
      const newPromoBalance = currentPromoBalance - promoSpent;
      const newMainBalance = currentMainBalance - mainSpent;
      const newTotalBalance = newPromoBalance + newMainBalance;

      await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
        data: {
          promoBalance: newPromoBalance,
          mainBalance: newMainBalance,
          balance: newTotalBalance
        }
      });

      // Create single consolidated transaction record for spending
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'payment',
          amount: spendAmount, // Total amount spent
          netAmount: spendAmount,
          transactionStatus: 'success',
          gateway: 'system',
          gatewayTransactionId: `spend_${Date.now()}`,
          fund_source: promoSpent > mainSpent ? 'promo_fund' : 'main_fund', // Use the dominant fund source
          description: transactionData.description || `Purchase payment (${promoSpent > 0 && mainSpent > 0 ? 'mixed funds' : promoSpent > 0 ? 'promo funds' : 'main funds'})`,
          user_wallet: wallet.id,
          users_permissions_user: userId,
          order: orderId,
          metadata: {
            ...transactionData.metadata,
            spendingBreakdown: {
              promoSpent: promoSpent,
              mainSpent: mainSpent,
              totalSpent: spendAmount
            }
          },
          publishedAt: new Date()
        }
      });

      console.log(`Spent ${amount} from wallet for user ${userId} (Promo: ${promoSpent}, Main: ${mainSpent})`);
      return {
        success: true,
        promoSpent,
        mainSpent,
        newPromoBalance,
        newMainBalance,
        newTotalBalance
      };
    } catch (error) {
      console.error('Error spending funds:', error);
      throw error;
    }
  },

  // Get wallet balance with separate tracking
  async getWalletBalance(userId) {
    try {
      const wallet = await this.getOrCreateWallet(userId);
      return {
        id: wallet.id,
        totalBalance: parseFloat(wallet.balance || 0),
        mainBalance: parseFloat(wallet.mainBalance || 0),
        promoBalance: parseFloat(wallet.promoBalance || 0),
        escrowBalance: parseFloat(wallet.escrowBalance || 0),
        pendingWithdrawalBalance: parseFloat(wallet.pendingWithdrawalBalance || 0),
        withdrawableBalance: parseFloat(wallet.mainBalance || 0), // Only main balance can be withdrawn
        currency: wallet.currency,
        type: wallet.type
      };
    } catch (error) {
      console.error('Error getting wallet balance:', error);
      throw error;
    }
  },

  // Validate withdrawal (only from main balance)
  async validateWithdrawal(userId, amount) {
    try {
      const wallet = await this.getOrCreateWallet(userId);
      const withdrawableBalance = parseFloat(wallet.mainBalance || 0);
      const requestedAmount = parseFloat(amount);

      if (withdrawableBalance < requestedAmount) {
        return {
          valid: false,
          error: 'Insufficient withdrawable funds',
          available: withdrawableBalance,
          requested: requestedAmount
        };
      }

      return {
        valid: true,
        available: withdrawableBalance,
        requested: requestedAmount
      };
    } catch (error) {
      console.error('Error validating withdrawal:', error);
      throw error;
    }
  }
}));

