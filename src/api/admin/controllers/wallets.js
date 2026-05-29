'use strict';

/**
 * Admin Wallet Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::user-wallet.user-wallet', ({ strapi }) => ({

  /**
   * Get all users wallet information with pagination and filters
   */
  async getAllWallets(ctx) {
    try {
      const { page = 1, pageSize = 20, search, sortBy = 'createdAt', sortOrder = 'desc' } = ctx.query;

      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} fetching all wallets - Page: ${page}, Size: ${pageSize}`);

      // Build query filters
      const filters = {};

      if (search) {
        filters.$or = [
          { users_permissions_user: { username: { $containsi: search } } },
          { users_permissions_user: { email: { $containsi: search } } }
        ];
      }

      // Handle sorting - only allow sorting by wallet fields, not user fields
      const allowedSortFields = ['createdAt', 'updatedAt', 'balance', 'mainBalance', 'promoBalance', 'escrowBalance', 'pendingWithdrawalBalance'];
      const finalSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';

      // Get wallets with user information
      const wallets = await strapi.db.query('api::user-wallet.user-wallet').findMany({
        where: filters,
        populate: {
          users_permissions_user: {
            select: ['id', 'username', 'email', 'firstName', 'lastName', 'createdAt']
          }
        },
        orderBy: { [finalSortBy]: sortOrder },
        limit: parseInt(pageSize),
        offset: (parseInt(page) - 1) * parseInt(pageSize)
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::user-wallet.user-wallet').count({
        where: filters
      });

      // Transform data for frontend
      const transformedWallets = wallets.map(wallet => ({
        id: wallet.id,
        userId: wallet.users_permissions_user?.id,
        username: wallet.users_permissions_user?.username || 'Unknown',
        email: wallet.users_permissions_user?.email || 'N/A',
        firstName: wallet.users_permissions_user?.firstName || '',
        lastName: wallet.users_permissions_user?.lastName || '',
        userCreatedAt: wallet.users_permissions_user?.createdAt,
        walletCreatedAt: wallet.createdAt,
        walletUpdatedAt: wallet.updatedAt,
        currency: wallet.currency,
        type: wallet.type,
        balance: parseFloat(wallet.balance || 0),
        mainBalance: parseFloat(wallet.mainBalance || 0),
        promoBalance: parseFloat(wallet.promoBalance || 0),
        escrowBalance: parseFloat(wallet.escrowBalance || 0),
        pendingWithdrawalBalance: parseFloat(wallet.pendingWithdrawalBalance || 0),
        withdrawableBalance: parseFloat(wallet.mainBalance || 0) - parseFloat(wallet.promoBalance || 0)
      }));

      // If sorting by username was requested, sort the transformed data
      if (sortBy === 'username') {
        transformedWallets.sort((a, b) => {
          const comparison = a.username.localeCompare(b.username);
          return sortOrder === 'asc' ? comparison : -comparison;
        });
      }

      const pageCount = Math.ceil(total / parseInt(pageSize));

      ctx.send({
        data: transformedWallets,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount,
            total
          }
        }
      });

    } catch (error) {
      console.error('[ADMIN WALLET ERROR]', error);
      return ctx.internalServerError('Failed to fetch wallet information');
    }
  },

  /**
   * Get wallet statistics
   */
  async getWalletStats(ctx) {
    try {
      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} fetching wallet statistics`);

      // Get total wallets count
      const totalWallets = await strapi.db.query('api::user-wallet.user-wallet').count();

      // Get aggregated wallet data
      const wallets = await strapi.db.query('api::user-wallet.user-wallet').findMany({
        select: ['balance', 'mainBalance', 'promoBalance', 'escrowBalance', 'pendingWithdrawalBalance']
      });

      // Calculate statistics
      const stats = wallets.reduce((acc, wallet) => {
        acc.totalBalance += parseFloat(wallet.balance || 0);
        acc.totalMainBalance += parseFloat(wallet.mainBalance || 0);
        acc.totalPromoBalance += parseFloat(wallet.promoBalance || 0);
        acc.totalEscrowBalance += parseFloat(wallet.escrowBalance || 0);
        acc.totalPendingWithdrawal += parseFloat(wallet.pendingWithdrawalBalance || 0);
        return acc;
      }, {
        totalBalance: 0,
        totalMainBalance: 0,
        totalPromoBalance: 0,
        totalEscrowBalance: 0,
        totalPendingWithdrawal: 0
      });

      // Get recent transaction count (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const recentTransactions = await strapi.db.query('api::transaction.transaction').count({
        where: {
          createdAt: { $gte: thirtyDaysAgo }
        }
      });

      ctx.send({
        totalWallets,
        totalBalance: stats.totalBalance,
        totalMainBalance: stats.totalMainBalance,
        totalPromoBalance: stats.totalPromoBalance,
        totalEscrowBalance: stats.totalEscrowBalance,
        totalPendingWithdrawal: stats.totalPendingWithdrawal,
        recentTransactions,
        averageBalance: totalWallets > 0 ? stats.totalBalance / totalWallets : 0
      });

    } catch (error) {
      console.error('[ADMIN WALLET STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch wallet statistics');
    }
  },

  /**
   * Get specific user wallet details
   */
  async getUserWallet(ctx) {
    try {
      const { userId } = ctx.params;

      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} fetching wallet for user ${userId}`);

      // Get user wallet with user information
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId },
        populate: {
          users_permissions_user: {
            select: ['id', 'username', 'email', 'firstName', 'lastName', 'createdAt']
          }
        }
      });

      if (!wallet) {
        return ctx.send({
          data: {
            id: null,
            mainBalance: 0,
            promoBalance: 0,
            escrowBalance: 0,
            pendingWithdrawalBalance: 0,
            withdrawableBalance: 0,
            currency: 'USD',
            type: 'user',
            walletCreatedAt: null,
            walletUpdatedAt: null
          }
        });
      }

      // Get recent transactions
      const transactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: { user_wallet: wallet.id },
        orderBy: { createdAt: 'desc' },
        limit: 10,
        populate: {
          user_wallet: {
            populate: {
              users_permissions_user: {
                select: ['username', 'email']
              }
            }
          }
        }
      });

      const transformedWallet = {
        id: wallet.id,
        userId: wallet.users_permissions_user?.id,
        username: wallet.users_permissions_user?.username || 'Unknown',
        email: wallet.users_permissions_user?.email || 'N/A',
        firstName: wallet.users_permissions_user?.firstName || '',
        lastName: wallet.users_permissions_user?.lastName || '',
        userCreatedAt: wallet.users_permissions_user?.createdAt,
        walletCreatedAt: wallet.createdAt,
        walletUpdatedAt: wallet.updatedAt,
        currency: wallet.currency,
        type: wallet.type,
        balance: parseFloat(wallet.balance || 0),
        mainBalance: parseFloat(wallet.mainBalance || 0),
        promoBalance: parseFloat(wallet.promoBalance || 0),
        escrowBalance: parseFloat(wallet.escrowBalance || 0),
        pendingWithdrawalBalance: parseFloat(wallet.pendingWithdrawalBalance || 0),
        withdrawableBalance: parseFloat(wallet.mainBalance || 0),
        recentTransactions: transactions.map(tx => ({
          id: tx.id,
          type: tx.type,
          amount: parseFloat(tx.amount || 0),
          description: tx.description,
          status: tx.transaction_status,
          createdAt: tx.createdAt,
          updatedAt: tx.updatedAt
        }))
      };

      ctx.send(transformedWallet);

    } catch (error) {
      console.error('[ADMIN WALLET USER ERROR]', error);
      return ctx.internalServerError('Failed to fetch user wallet information');
    }
  },

  /**
   * Get user wallet transactions
   */
  async getUserTransactions(ctx) {
    try {
      const { userId } = ctx.params;
      const { page = 1, pageSize = 20, type, status } = ctx.query;

      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} fetching transactions for user ${userId}`);

      // Get user wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.send({
          data: [],
          meta: {
            pagination: {
              page: parseInt(page),
              pageSize: parseInt(pageSize),
              pageCount: 0,
              total: 0
            }
          }
        });
      }

      // Build transaction filters
      const filters = { user_wallet: wallet.id };
      if (type) filters.type = type;
      // DB column is `transaction_status` (there is no `status` column), so a
      // `status` filter/select silently returned undefined -> UI showed every
      // transaction as "Pending". Use the real column name.
      if (status) filters.transaction_status = status;

      // Get transactions
      const transactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: filters,
        orderBy: { createdAt: 'desc' },
        limit: parseInt(pageSize),
        offset: (parseInt(page) - 1) * parseInt(pageSize)
      });

      // Get total count
      const total = await strapi.db.query('api::transaction.transaction').count({
        where: filters
      });

      const pageCount = Math.ceil(total / parseInt(pageSize));

      ctx.send({
        data: transactions.map(tx => ({
          id: tx.id,
          type: tx.type,
          amount: parseFloat(tx.amount || 0),
          description: tx.description,
          status: tx.transaction_status,
          createdAt: tx.createdAt,
          updatedAt: tx.updatedAt
        })),
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount,
            total
          }
        }
      });

    } catch (error) {
      console.error('[ADMIN WALLET TRANSACTIONS ERROR]', error);
      return ctx.internalServerError('Failed to fetch user transactions');
    }
  },

  /**
   * Update user wallet balance (admin action)
   */
  async updateWalletBalance(ctx) {
    try {
      const { userId } = ctx.params;
      const { mainBalance, promoBalance, reason } = ctx.request.body;

      console.log(`[ADMIN WALLET] Admin ${ctx.state.user.id} updating wallet balance for user ${userId}`);

      // Get user wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId },
        populate: ['users_permissions_user']
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found for this user');
      }

      const prevMain = parseFloat(wallet.mainBalance || 0);
      const prevPromo = parseFloat(wallet.promoBalance || 0);
      const nextMain = mainBalance !== undefined ? parseFloat(mainBalance) : prevMain;
      const nextPromo = promoBalance !== undefined ? parseFloat(promoBalance) : prevPromo;
      const mainDelta = nextMain - prevMain;
      const promoDelta = nextPromo - prevPromo;
      const creditDelta = (mainDelta > 0 ? mainDelta : 0) + (promoDelta > 0 ? promoDelta : 0);

      // Update wallet balance
      const updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
        data: {
          mainBalance: nextMain,
          promoBalance: nextPromo,
          balance: nextMain + nextPromo
        }
      });

      // Record adjustment as a proper transaction when admin provides a reason
      let adjustmentTx = null;
      if (reason && creditDelta !== 0) {
        const isCredit = creditDelta > 0;
        adjustmentTx = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            user_wallet: wallet.id,
            users_permissions_user: userId,
            type: 'deposit',
            amount: Math.abs(creditDelta),
            netAmount: Math.abs(creditDelta),
            transactionStatus: 'success',
            gateway: 'system',
            gatewayTransactionId: `ADMIN_ADJUST_${wallet.id}_${Date.now()}`,
            fund_source: mainDelta >= promoDelta ? 'main_fund' : 'promo_fund',
            description: `Admin ${isCredit ? 'credit' : 'debit'}: ${reason}`,
            fee: 0,
            publishedAt: new Date()
          }
        });

        if (isCredit) {
          try {
            const userEmail = wallet.users_permissions_user?.email;
            if (userEmail && adjustmentTx?.id) {
              await strapi.service('api::global.email-operations').sendTransactionEmail({
                transaction: adjustmentTx,
                userEmail,
                statusLabel: 'success',
                statusMessage: 'Your wallet has been credited successfully.',
                notes: reason,
                flags: { is_wallet_credit: true },
                tags: ['transaction', 'wallet', 'credit', 'manual'],
              });
            }
          } catch (emailErr) {
            console.error('[ADMIN WALLET] Failed to send manual-credit email:', emailErr.message);
          }
        }
      }

      ctx.send({
        message: 'Wallet balance updated successfully',
        wallet: {
          id: updatedWallet.id,
          mainBalance: parseFloat(updatedWallet.mainBalance || 0),
          promoBalance: parseFloat(updatedWallet.promoBalance || 0),
          balance: parseFloat(updatedWallet.balance || 0)
        }
      });

    } catch (error) {
      console.error('[ADMIN WALLET UPDATE ERROR]', error);
      return ctx.internalServerError('Failed to update wallet balance');
    }
  },

  /**
   * Create manual transaction (admin action) — e.g. recording an offline payment.
   * Atomically updates the user's wallet balance and writes a paired transaction row.
   * Wallet is only mutated when transactionStatus is 'success'; non-success rows are
   * recorded for audit only (e.g. logging a pending bank transfer that hasn't cleared).
   */
  async createTransaction(ctx) {
    try {
      const { userId } = ctx.params;
      const {
        type,
        amount,
        description,
        fundSource = 'main_fund',
        gateway = 'system',
        transactionStatus = 'success',
        fee: feeInput = 0,
        gatewayTransactionId: gatewayTxnIdInput,
        externalReference,
        promoCodeId,
        notes,
      } = ctx.request.body;

      const adminUser = ctx.state.user;
      console.log(`[ADMIN WALLET] Admin ${adminUser.id} creating ${type}/${gateway}/${transactionStatus} transaction for user ${userId}`);

      // Validate type
      const CREDIT_TYPES = ['deposit', 'refund', 'promo', 'escrow_release'];
      const DEBIT_TYPES = ['withdrawal', 'fee', 'payment', 'payout', 'escrow_hold'];
      const ALLOWED_TYPES = [...CREDIT_TYPES, ...DEBIT_TYPES];
      if (!ALLOWED_TYPES.includes(type)) {
        return ctx.badRequest(`Invalid transaction type. Allowed: ${ALLOWED_TYPES.join(', ')}`);
      }

      // Validate gateway (must mirror schema enum)
      const ALLOWED_GATEWAYS = ['stripe', 'paypal', 'razorpay', 'promo', 'voucher', 'system', 'bank_transfer'];
      if (!ALLOWED_GATEWAYS.includes(gateway)) {
        return ctx.badRequest(`Invalid gateway. Allowed: ${ALLOWED_GATEWAYS.join(', ')}`);
      }

      // Validate status
      const ALLOWED_STATUSES = ['pending', 'success', 'failed', 'cancelled', 'approved', 'refunded', 'denied', 'paid'];
      if (!ALLOWED_STATUSES.includes(transactionStatus)) {
        return ctx.badRequest(`Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}`);
      }

      // Validate amount
      const parsedAmount = parseFloat(amount);
      if (!parsedAmount || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
        return ctx.badRequest('Amount must be a positive number');
      }

      // Validate fee
      const parsedFee = parseFloat(feeInput) || 0;
      if (parsedFee < 0) {
        return ctx.badRequest('Fee cannot be negative');
      }
      if (parsedFee >= parsedAmount) {
        return ctx.badRequest('Fee must be less than amount');
      }
      const netAmount = parsedAmount - parsedFee;

      // Validate fund source
      if (!['main_fund', 'promo_fund'].includes(fundSource)) {
        return ctx.badRequest('Invalid fund source. Allowed: main_fund, promo_fund');
      }

      // Description is required so the audit trail explains why the row exists
      if (!description || !String(description).trim()) {
        return ctx.badRequest('Description is required');
      }

      // Get user wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId },
        populate: ['users_permissions_user'],
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found for this user');
      }

      const isCredit = CREDIT_TYPES.includes(type);
      const isSettled = transactionStatus === 'success';
      const balanceField = fundSource === 'promo_fund' ? 'promoBalance' : 'mainBalance';
      const prevFieldBalance = parseFloat(wallet[balanceField] || 0);
      const prevTotal = parseFloat(wallet.balance || 0);

      // Wallet movement: credit by netAmount (user receives net of fee); debit by gross amount
      // (full amount leaves wallet, platform retains fee). Only when settled.
      let nextFieldBalance = prevFieldBalance;
      let nextTotal = prevTotal;
      if (isSettled) {
        if (isCredit) {
          nextFieldBalance = prevFieldBalance + netAmount;
          nextTotal = prevTotal + netAmount;
        } else {
          if (prevFieldBalance < parsedAmount) {
            return ctx.badRequest(`Insufficient ${fundSource} balance for ${type}`);
          }
          nextFieldBalance = prevFieldBalance - parsedAmount;
          nextTotal = prevTotal - parsedAmount;
        }
      }

      const trimmedGatewayTxnId = (gatewayTxnIdInput && String(gatewayTxnIdInput).trim()) || null;
      const trimmedExternalRef = (externalReference && String(externalReference).trim()) || null;
      const finalGatewayTxnId =
        trimmedGatewayTxnId ||
        trimmedExternalRef ||
        `ADMIN_MANUAL_${wallet.id}_${Date.now()}`;

      // Atomic update: wallet balance (when settled) + paired transaction row
      const result = await strapi.db.transaction(async () => {
        let updatedWallet = wallet;
        if (isSettled) {
          updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
            data: {
              [balanceField]: nextFieldBalance,
              balance: nextTotal,
            },
          });
        }

        const paymentNotesParts = [
          `Admin: ${adminUser.username || adminUser.id}`,
          notes ? `Notes: ${notes}` : null,
          trimmedExternalRef ? `External Ref: ${trimmedExternalRef}` : null,
        ].filter(Boolean);

        const transaction = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            user_wallet: wallet.id,
            users_permissions_user: userId,
            type,
            amount: parsedAmount,
            netAmount,
            fee: parsedFee,
            transactionStatus,
            gateway,
            gatewayTransactionId: finalGatewayTxnId,
            external_transaction_id: trimmedExternalRef || undefined,
            fund_source: fundSource,
            description: String(description).trim(),
            payment_notes: paymentNotesParts.join(' | '),
            promo_code_id: (promoCodeId && String(promoCodeId).trim()) || undefined,
            publishedAt: new Date(),
          },
        });

        return { updatedWallet, transaction };
      });

      // Audit log (best-effort — don't fail the operation)
      try {
        await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
          data: {
            adminUser: adminUser.id,
            action: 'wallet_manual_transaction',
            targetUser: userId,
            details: {
              walletId: wallet.id,
              type,
              gateway,
              transactionStatus,
              amount: parsedAmount,
              fee: parsedFee,
              netAmount,
              fundSource,
              previousBalance: prevTotal,
              newBalance: parseFloat(result.updatedWallet.balance || 0),
              walletMutated: isSettled,
              transactionId: result.transaction.id,
              gatewayTransactionId: finalGatewayTxnId,
              externalReference: trimmedExternalRef,
              promoCodeId: promoCodeId || null,
              description,
              notes: notes || null,
            },
            ipAddress: ctx.request.ip,
            userAgent: ctx.request.headers['user-agent'],
          },
        });
      } catch (auditErr) {
        console.error('[ADMIN WALLET] Failed to write audit log:', auditErr.message);
      }

      // Notification email (best-effort — only credits that actually settled notify users)
      if (isCredit && isSettled) {
        try {
          const userEmail = wallet.users_permissions_user?.email;
          if (userEmail && result.transaction?.id) {
            await strapi.service('api::global.email-operations').sendTransactionEmail({
              transaction: result.transaction,
              userEmail,
              statusLabel: 'success',
              statusMessage: 'Your wallet has been credited successfully.',
              notes: description,
              flags: { is_wallet_credit: true, is_manual: true },
              tags: ['transaction', 'wallet', 'credit', 'manual'],
            });
          }
        } catch (emailErr) {
          console.error('[ADMIN WALLET] Failed to send manual-transaction email:', emailErr.message);
        }
      }

      ctx.send({
        message: isSettled
          ? 'Transaction created and wallet updated'
          : 'Transaction recorded (wallet unchanged — non-success status)',
        transaction: {
          id: result.transaction.id,
          type: result.transaction.type,
          amount: parseFloat(result.transaction.amount || 0),
          fee: parseFloat(result.transaction.fee || 0),
          netAmount: parseFloat(result.transaction.netAmount || 0),
          description: result.transaction.description,
          transactionStatus: result.transaction.transactionStatus,
          gateway: result.transaction.gateway,
          gatewayTransactionId: result.transaction.gatewayTransactionId,
          external_transaction_id: result.transaction.external_transaction_id,
          fund_source: result.transaction.fund_source,
          promo_code_id: result.transaction.promo_code_id,
          createdAt: result.transaction.createdAt,
        },
        wallet: {
          id: result.updatedWallet.id,
          mainBalance: parseFloat(result.updatedWallet.mainBalance || 0),
          promoBalance: parseFloat(result.updatedWallet.promoBalance || 0),
          balance: parseFloat(result.updatedWallet.balance || 0),
        },
      });

    } catch (error) {
      console.error('[ADMIN WALLET TRANSACTION ERROR]', error);
      return ctx.internalServerError('Failed to create transaction');
    }
  },

  /**
   * Handle wallet operations (add funds, remove funds, set balance, transfer)
   */
  async walletOperation(ctx) {
    try {
      const { walletId } = ctx.params;
      const {
        type,
        amount,
        transactionType,
        transactionId,
        reason,
        notes,
        targetUserId,
        fundSource = 'main'
      } = ctx.request.body;

      console.log(`[ADMIN WALLET OPERATION] Admin ${ctx.state.user.id} performing ${type} operation on wallet ${walletId}`);

      // Validate required fields
      if (!type || !amount || !transactionType || !transactionId || !reason) {
        return ctx.badRequest('Missing required fields: type, amount, transactionType, transactionId, reason');
      }

      // Validate amount
      if (amount <= 0) {
        return ctx.badRequest('Amount must be greater than 0');
      }

      // Validate operation type
      const validTypes = ['add_funds', 'remove_funds', 'set_balance', 'transfer_funds'];
      if (!validTypes.includes(type)) {
        return ctx.badRequest('Invalid operation type');
      }

      // Get the wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId },
        populate: ['users_permissions_user']
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }

      // Get admin user info for logging
      const adminUser = ctx.state.user;
      if (!adminUser) {
        return ctx.unauthorized('Admin authentication required');
      }

      // Start database transaction
      const result = await strapi.db.transaction(async (trx) => {
        let updatedWallet;
        let transactionRecord;
        let targetWallet = null;

        switch (type) {
          case 'add_funds':
            // Add funds to specified balance type
            const addUpdateData = {};
            addUpdateData[`${fundSource}Balance`] = wallet[`${fundSource}Balance`] + amount;
            addUpdateData.balance = wallet.balance + amount;

            updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
              data: addUpdateData
            });

            // Create transaction record
            transactionRecord = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'deposit', // Use valid enum value
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: 'main_fund', // Use valid enum value
                description: `Admin added funds: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Admin: ${adminUser.username} | Type: ${transactionType} | Notes: ${notes || 'N/A'}`,
                user_wallet: walletId,
                users_permissions_user: wallet.users_permissions_user.id,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });
            break;

          case 'remove_funds':
            // Check sufficient balance
            if (wallet[`${fundSource}Balance`] < amount) {
              throw new Error(`Insufficient ${fundSource} balance`);
            }

            // Remove funds from specified balance type
            const removeUpdateData = {};
            removeUpdateData[`${fundSource}Balance`] = wallet[`${fundSource}Balance`] - amount;
            removeUpdateData.balance = wallet.balance - amount;

            updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
              data: removeUpdateData
            });

            // Create transaction record
            transactionRecord = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'withdrawal', // Use valid enum value
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: fundSource === 'main' ? 'main_fund' : 'promo_fund', // Use valid enum value
                description: `Admin removed funds: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Admin: ${adminUser.username} | Type: ${transactionType} | Notes: ${notes || 'N/A'}`,
                user_wallet: walletId,
                users_permissions_user: wallet.users_permissions_user.id,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });
            break;

          case 'set_balance':
            // Set specific balance amounts
            const setUpdateData = {
              mainBalance: fundSource === 'main' ? amount : wallet.mainBalance,
              promoBalance: fundSource === 'promo' ? amount : wallet.promoBalance,
              escrowBalance: fundSource === 'escrow' ? amount : wallet.escrowBalance,
              balance: 0 // Will be recalculated
            };

            // Recalculate total balance
            setUpdateData.balance = setUpdateData.mainBalance + setUpdateData.promoBalance + setUpdateData.escrowBalance;

            updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
              data: setUpdateData
            });

            // Create transaction record
            transactionRecord = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'deposit', // Use valid enum value for balance setting
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: fundSource === 'main' ? 'main_fund' : 'promo_fund', // Use valid enum value
                description: `Admin set ${fundSource} balance: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Notes: ${notes || 'N/A'}`,
                user_wallet: walletId,
                users_permissions_user: wallet.users_permissions_user.id,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });
            break;

          case 'transfer_funds':
            if (!targetUserId) {
              throw new Error('Target user ID required for transfer');
            }

            // Check sufficient balance
            if (wallet[`${fundSource}Balance`] < amount) {
              throw new Error(`Insufficient ${fundSource} balance for transfer`);
            }

            // Get target wallet
            targetWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
              where: { users_permissions_user: targetUserId }
            });

            if (!targetWallet) {
              throw new Error('Target user wallet not found');
            }

            // Update source wallet
            const sourceUpdateData = {};
            sourceUpdateData[`${fundSource}Balance`] = wallet[`${fundSource}Balance`] - amount;
            sourceUpdateData.balance = wallet.balance - amount;

            await strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
              data: sourceUpdateData
            });

            // Update target wallet
            const targetUpdateData = {};
            targetUpdateData[`${fundSource}Balance`] = targetWallet[`${fundSource}Balance`] + amount;
            targetUpdateData.balance = targetWallet.balance + amount;

            await strapi.entityService.update('api::user-wallet.user-wallet', targetWallet.id, {
              data: targetUpdateData
            });

            // Create transaction records for both wallets
            const sourceTransaction = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'withdrawal', // Use valid enum value
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: fundSource === 'main' ? 'main_fund' : 'promo_fund', // Use valid enum value
                description: `Transfer to user ${targetUserId}: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Admin: ${adminUser.username} | Type: ${transactionType} | Notes: ${notes || 'N/A'}`,
                user_wallet: walletId,
                users_permissions_user: wallet.users_permissions_user.id,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });

            const targetTransaction = await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'deposit', // Use valid enum value
                amount: amount,
                netAmount: amount, // Required field
                transactionStatus: 'success',
                gateway: 'system', // Use valid enum value
                gatewayTransactionId: transactionId,
                fund_source: fundSource === 'main' ? 'main_fund' : 'promo_fund', // Use valid enum value
                description: `Transfer from user ${wallet.users_permissions_user.id}: ${reason}`,
                external_transaction_id: transactionId,
                payment_notes: `Admin: ${adminUser.username} | Type: ${transactionType} | Notes: ${notes || 'N/A'}`,
                user_wallet: targetWallet.id,
                users_permissions_user: targetUserId,
                fee: 0,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });

            updatedWallet = await strapi.entityService.findOne('api::user-wallet.user-wallet', walletId);
            transactionRecord = sourceTransaction;
            break;

          default:
            throw new Error('Invalid operation type');
        }

        // Create admin audit log
        await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
          data: {
            adminUser: adminUser.id,
            action: `wallet_${type}`,
            targetUser: wallet.users_permissions_user.id,
            details: {
              walletId: walletId,
              operation: type,
              amount: amount,
              transactionType: transactionType,
              transactionId: transactionId,
              reason: reason,
              notes: notes,
              fundSource: fundSource,
              targetUserId: targetUserId,
              previousBalance: wallet.balance,
              newBalance: updatedWallet.balance,
              transactionRecordId: transactionRecord.id
            },
            ipAddress: ctx.request.ip,
            userAgent: ctx.request.headers['user-agent'],
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });

        return {
          wallet: updatedWallet,
          transaction: transactionRecord,
          targetWallet: targetWallet
        };
      });

      // Send notification to user
      try {
        await strapi.service('api::notification.notification').create({
          data: {
            user: wallet.users_permissions_user.id,
            type: 'wallet_operation',
            title: 'Wallet Updated',
            message: `Your wallet has been updated by admin. ${type.replace('_', ' ')}: $${amount}`,
            data: {
              operation: type,
              amount: amount,
              transactionId: transactionId,
              reason: reason
            },
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });
      } catch (notificationError) {
        console.error('Failed to send notification:', notificationError);
        // Don't fail the operation if notification fails
      }

      console.log(`[ADMIN WALLET OPERATION] Successfully completed ${type} operation on wallet ${walletId}`);

      ctx.body = {
        success: true,
        message: 'Wallet operation completed successfully',
        data: {
          wallet: result.wallet,
          transaction: result.transaction,
          targetWallet: result.targetWallet
        }
      };

    } catch (error) {
      console.error('[ADMIN WALLET OPERATION ERROR]', error);
      ctx.internalServerError('Failed to perform wallet operation: ' + error.message);
    }
  }

}));
