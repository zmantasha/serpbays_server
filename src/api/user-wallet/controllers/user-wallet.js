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

      // Pagination with hard caps. Pre-fix `pageSize` was caller-supplied
      // and unbounded — request `pageSize=10_000_000` to attempt DoS via
      // a huge JSON serialization. Cap at 100; non-numeric falls back to 10.
      const rawPage = Number.parseInt(ctx.query?.page, 10);
      const rawPageSize = Number.parseInt(ctx.query?.pageSize, 10);
      const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
      const limit = Number.isFinite(rawPageSize) && rawPageSize >= 1
        ? Math.min(rawPageSize, 100)
        : 10;
      const offset = (page - 1) * limit;

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
      const bonusTx = await strapi.db.query('api::transaction.transaction').create({
        data: {
          type: codeType === 'voucher' ? 'promo' : codeType, // Use 'promo' type for both voucher and promo codes
          amount: codeAmount,
          netAmount: codeAmount,
          transactionStatus: 'success',
          gateway: codeType === 'voucher' ? 'voucher' : 'promo',
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

      try {
        const userEmail = ctx.state?.user?.email;
        if (bonusTx?.id && userEmail) {
          await strapi.service('api::global.email-operations').sendTransactionEmail({
            transaction: bonusTx,
            userEmail,
            statusLabel: 'success',
            statusMessage: `A ${codeType === 'voucher' ? 'voucher' : 'promo'} bonus has been added to your wallet.`,
            notes: `${codeType === 'voucher' ? 'Voucher' : 'Promo'} code redemption: ${promoCode}`,
            flags: { is_bonus: true },
            tags: ['transaction', 'bonus', codeType, 'success'],
          });
        }
      } catch (emailErr) {
        console.error('[PROMO/VOUCHER] Failed to send bonus email:', emailErr.message);
      }

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
      strapi.log?.error?.('[promo] redeemPromo failed', { error: error.message });
      return ctx.badRequest('Failed to redeem code');
    }
  },

  // Check promo code or voucher code validity
  // POST /api/wallet/check-promo — validate code WITHOUT consuming it.
  // Audit notes:
  //   - Pre-fix had no in-handler auth check. The route declares
  //     `auth:{}` (empty), which Strapi treats as "any auth strategy
  //     accepted but no specific permission required" — semantics shift
  //     across Strapi versions. We add an explicit unauthorized() guard
  //     so anonymous callers cannot brute-force codes regardless of
  //     route-config interpretation.
  //   - Length-cap the code to defeat pathological inputs.
  //   - The response still returns the bonus `amount` on valid hits —
  //     end users need it to make an informed redemption decision. Brute-
  //     force risk is reduced by requiring authentication (attackers are
  //     traceable to an account) but not eliminated — recommend per-IP +
  //     per-user rate limit middleware as ops follow-up.
  //   - `error.message` no longer echoed; server-side log only.
  async checkPromoCode(ctx) {
    try {
      const userId = ctx.state?.user?.id;
      if (!userId) {
        return ctx.unauthorized('Authentication required');
      }
      const { promoCode } = ctx.request.body || {};
      if (typeof promoCode !== 'string' || promoCode.length === 0 || promoCode.length > 64) {
        return ctx.badRequest('Promo code is required');
      }

      let codeData = null;
      let codeType = 'promo';

      const promo = await strapi.db.query('api::promo-code.promo-code').findOne({
        where: {
          code: promoCode,
          promoStatus: 'active',
          expiryDate: { $gt: new Date() }
        }
      });

      if (promo) {
        codeData = promo;
        codeType = 'promo';
      } else {
        const voucher = await strapi.db.query('api::voucher-code.voucher-code').findOne({
          where: {
            code: promoCode,
            voucherStatus: 'active',
            expiryDate: { $gt: new Date() }
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
          codeType,
          amount: codeData.amount,
          expiryDate: codeData.expiryDate,
        },
      };
    } catch (error) {
      strapi.log?.error?.('[promo] checkPromoCode failed', { error: error.message });
      return ctx.badRequest('Failed to check code');
    }
  },

  // Audit C5 — `fixCompletedOrderEarnings` handler removed.
  // The handler iterated ALL system-wide completed orders and credited
  // `order.totalAmount` to publishers without idempotency (the existing-tx
  // branch double-credited the same earnings on every call). It was reachable
  // by any authenticated user via `POST /api/wallet/fix-earnings`, allowing
  // any user to inflate publisher wallets by N× total order volume.
  // The route is deleted in `src/api/user-wallet/routes/user-wallet.js` and
  // the up_permissions rows are purged by the security migration
  // `2026.06.17T00.00.00.security-remove-fix-earnings-route.js`.
  // Regression test: `scripts/test-fix-earnings-removed.js`.

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

      // Emit real-time wallet update — every webhook controller + the
      // order-refund flow + admin manual credit eventually reach this
      // helper, so patching here covers all of them at once.
      try {
        await strapi
          .service('api::user-wallet.user-wallet')
          .emitBalanceUpdate(userId, transactionData.type || 'deposit', {
            txAmount: parseFloat(amount),
            gateway: transactionData.gateway || 'system',
            gatewayTransactionId: transactionData.gatewayTransactionId,
            orderId: transactionData.order || null,
          });
      } catch (_) { /* emit is best-effort; DB is source of truth */ }

      return { success: true, newMainBalance, newTotalBalance };
    } catch (error) {
      console.error('Error adding main funds:', error);
      throw error;
    }
  },

  // PUBLIC HTTP wrapper for adding funds — DISABLED.
  //
  // CRITICAL: the pre-fix implementation took `amount`, `paymentMethod`, and
  // `transactionId` from ctx.request.body and called `addMainFunds(userId,
  // amount, ...)` directly. NO payment-gateway verification. The
  // Authenticated role has `api::user-wallet.user-wallet.addFunds`
  // permission, so ANY logged-in user could POST
  //   /api/wallet/add-funds {amount:<arbitrary>, paymentMethod:'manual'}
  // and credit their own wallet with arbitrary money. Free funds.
  //
  // Legitimate top-up flows:
  //   POST /api/transactions/payment    → creates a pending transaction
  //   Gateway webhooks                  → credit wallet after confirmed payment
  //     (paypal-webhook, razorpay-webhook, stripe-webhook, phonepe-webhook;
  //      all signature-verified, all M11 amount-checked)
  //   POST /api/transactions/verify-paypal → server-authoritative manual verify
  //   Admin bank-transfer approval (admin-gated, post-Pass-7)
  //   redeemPromo (separate handler — voucher / promo code path)
  //
  // The internal `addMainFunds(userId, amount, ...)` helper remains for
  // those legitimate server-side credit paths (called by the webhook
  // controllers and the order-refund flow). Only the HTTP wrapper is
  // closed off.
  //
  // Returning 410 (Gone) so any client still hitting this surfaces clearly
  // in logs/alerts rather than failing silently like a 403.
  async addFunds(ctx) {
    strapi.log?.warn?.(
      `[user-wallet] DISABLED /api/wallet/add-funds called by user=${ctx.state?.user?.id ?? 'anon'} ip=${ctx.request.ip}`
    );
    ctx.status = 410;
    ctx.body = {
      error: 'gone',
      message: 'Direct wallet credit is not available. Use the payment-intent / webhook flow.',
    };
    return;
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

      // Real-time wallet update — covers redeemPromo + offer-engine bonus
      // application (the legitimate consumers of this helper).
      try {
        await strapi
          .service('api::user-wallet.user-wallet')
          .emitBalanceUpdate(userId, 'promo_redemption', {
            txAmount: parseFloat(amount),
            promoCodeId,
          });
      } catch (_) { /* best-effort */ }

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

      // Real-time wallet update — caught by AI credit-burn + order spend
      // + every other spendFunds caller.
      try {
        await strapi
          .service('api::user-wallet.user-wallet')
          .emitBalanceUpdate(userId, 'spend', {
            txAmount: spendAmount,
            promoSpent,
            mainSpent,
            orderId,
          });
      } catch (_) { /* best-effort */ }

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

