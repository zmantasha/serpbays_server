'use strict';

/**
 * Admin Transactions Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::transaction.transaction', ({ strapi }) => ({

  /**
   * Get all transactions with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const {
        page = 1,
        pageSize = 20,
        sort = 'createdAt:desc',
        search = '',
        status = '',
        type = '',
        gateway = '',
        userId = ''
      } = ctx.query;

      // Build filters
      const filters = {};

      // Search filter — matches transaction id, gateway txn id, description,
      // and the related user's username / email.
      if (search) {
        filters.$or = [
          { gatewayTransactionId: { $containsi: search } },
          { description: { $containsi: search } },
          { users_permissions_user: { username: { $containsi: search } } },
          { users_permissions_user: { email: { $containsi: search } } },
          { id: { $eq: parseInt(search) || 0 } }
        ];
      }

      // Status filter — "completed" is a virtual status meaning "settled"
      // (success OR paid), mirroring the stats controller's SETTLED definition.
      if (status) {
        filters.transactionStatus = status === 'completed'
          ? { $in: ['success', 'paid'] }
          : status;
      }

      // Type filter
      if (type) {
        filters.type = type;
      }

      // Gateway filter
      if (gateway) {
        filters.gateway = gateway;
      }

      // User filter
      if (userId) {
        filters.users_permissions_user = userId;
      }

      // Calculate pagination using start/limit (entityService findMany)
      const pageNum = parseInt(page)
      const sizeNum = parseInt(pageSize)
      const start = (pageNum - 1) * sizeNum
      const limit = sizeNum

      // Get transactions with simplified populate
      const transactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters,
        sort,
        start,
        limit,
        populate: ['users_permissions_user', 'order']
      });

      // Alias `type` to `transactionType` for admin frontend compatibility
      const normalized = (transactions || []).map(t => ({
        ...t,
        transactionType: t.type
      }));

      // Get total count for pagination
      const total = await strapi.db.query('api::transaction.transaction').count({ where: filters });

      ctx.send({
        data: normalized,
        meta: {
          pagination: {
            page: pageNum,
            pageSize: sizeNum,
            pageCount: Math.ceil(total / sizeNum),
            total
          }
        }
      });

    } catch (error) {
      console.error('[ADMIN TRANSACTIONS FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch transactions');
    }
  },

  /**
   * Get single transaction with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;

      const transaction = await strapi.entityService.findOne('api::transaction.transaction', id, {
        populate: {
          users_permissions_user: {
            fields: ['id', 'username', 'email']
          },
          order: {
            populate: ['advertiser', 'publisher']
          }
        }
      });

      if (!transaction) {
        return ctx.notFound('Transaction not found');
      }

      ctx.send({
        data: transaction ? { ...transaction, transactionType: transaction.type } : null
      });

    } catch (error) {
      console.error('[ADMIN TRANSACTION FIND ONE ERROR]', error);
      return ctx.internalServerError('Failed to fetch transaction details');
    }
  },

  /**
   * Update an existing transaction (admin action).
   *
   * Editable fields: description, gateway, gatewayTransactionId, external_transaction_id,
   * promo_code_id, payment_notes, transactionStatus.
   *
   * Immutable: type, amount, fee, netAmount, fund_source, user_wallet,
   * users_permissions_user. To "edit" those, void this transaction and create a new
   * corrective one — keeps the audit trail honest.
   *
   * Wallet reversal: when the status flips between settled (success) and not-settled
   * (anything else), the wallet is adjusted to match. Other status transitions leave
   * the wallet alone.
   */
  async update(ctx) {
    try {
      const { id } = ctx.params;
      const {
        description,
        gateway,
        gatewayTransactionId,
        externalReference,
        promoCodeId,
        paymentNotes,
        transactionStatus,
        adminNotes,
      } = ctx.request.body;

      const adminUser = ctx.state.user;
      console.log(`[ADMIN ACTION] Admin ${adminUser.id} editing transaction ${id}`);

      // Load existing transaction with wallet
      const existing = await strapi.entityService.findOne('api::transaction.transaction', id, {
        populate: { user_wallet: true, users_permissions_user: true },
      });
      if (!existing) {
        return ctx.notFound('Transaction not found');
      }

      // Validate gateway if provided
      const ALLOWED_GATEWAYS = ['stripe', 'paypal', 'razorpay', 'promo', 'voucher', 'system', 'bank_transfer'];
      if (gateway !== undefined && !ALLOWED_GATEWAYS.includes(gateway)) {
        return ctx.badRequest(`Invalid gateway. Allowed: ${ALLOWED_GATEWAYS.join(', ')}`);
      }

      // Validate status if provided
      const ALLOWED_STATUSES = ['pending', 'success', 'failed', 'cancelled', 'approved', 'refunded', 'denied', 'paid'];
      if (transactionStatus !== undefined && !ALLOWED_STATUSES.includes(transactionStatus)) {
        return ctx.badRequest(`Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}`);
      }

      // Wallet reversal logic — only on success ↔ non-success transitions
      const wasSettled = existing.transactionStatus === 'success';
      const willBeSettled = transactionStatus !== undefined
        ? transactionStatus === 'success'
        : wasSettled;

      const CREDIT_TYPES = ['deposit', 'refund', 'promo', 'escrow_release'];
      const isCredit = CREDIT_TYPES.includes(existing.type);
      const fundSource = existing.fund_source || 'main_fund';
      const balanceField = fundSource === 'promo_fund' ? 'promoBalance' : 'mainBalance';
      const txAmount = parseFloat(existing.amount || 0);
      const txNetAmount = parseFloat(existing.netAmount || existing.amount || 0);

      let walletDelta = 0; // signed: positive credits the user, negative debits
      if (wasSettled && !willBeSettled) {
        // Reverse: undo the original effect
        walletDelta = isCredit ? -txNetAmount : txAmount;
      } else if (!wasSettled && willBeSettled) {
        // Apply: settle for the first time
        walletDelta = isCredit ? txNetAmount : -txAmount;
      }

      // If we're applying a debit, ensure the wallet has the funds
      const wallet = existing.user_wallet
        ? await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { id: existing.user_wallet.id },
          })
        : null;

      if (walletDelta !== 0) {
        if (!wallet) {
          return ctx.badRequest('Cannot adjust wallet: linked wallet not found');
        }
        if (walletDelta < 0) {
          const currentField = parseFloat(wallet[balanceField] || 0);
          if (currentField + walletDelta < 0) {
            return ctx.badRequest(
              `Cannot settle as success: insufficient ${fundSource} balance to debit ${Math.abs(walletDelta).toFixed(2)}`
            );
          }
        }
      }

      // Build the update payload — only set fields that were provided
      const updateData = {};
      if (description !== undefined) updateData.description = String(description).trim();
      if (gateway !== undefined) updateData.gateway = gateway;
      if (gatewayTransactionId !== undefined) {
        const trimmed = String(gatewayTransactionId).trim();
        if (!trimmed) {
          return ctx.badRequest('gatewayTransactionId cannot be blank (it is required by the schema)');
        }
        updateData.gatewayTransactionId = trimmed;
      }
      if (externalReference !== undefined) {
        const trimmed = String(externalReference).trim();
        updateData.external_transaction_id = trimmed || null;
      }
      if (promoCodeId !== undefined) {
        const trimmed = String(promoCodeId).trim();
        updateData.promo_code_id = trimmed || null;
      }
      if (paymentNotes !== undefined) {
        updateData.payment_notes = String(paymentNotes).trim();
      } else if (adminNotes && String(adminNotes).trim()) {
        // Append admin notes to existing payment_notes for an audit trail
        const stamp = new Date().toISOString();
        const line = `[${stamp}] Admin ${adminUser.username || adminUser.id}: ${String(adminNotes).trim()}`;
        updateData.payment_notes = existing.payment_notes
          ? `${existing.payment_notes}\n${line}`
          : line;
      }
      if (transactionStatus !== undefined) updateData.transactionStatus = transactionStatus;

      // Atomic: transaction update + wallet adjustment
      const result = await strapi.db.transaction(async () => {
        const updatedTx = await strapi.entityService.update('api::transaction.transaction', id, {
          data: updateData,
          populate: ['users_permissions_user', 'order', 'user_wallet'],
        });

        let updatedWallet = wallet;
        if (walletDelta !== 0 && wallet) {
          const prevField = parseFloat(wallet[balanceField] || 0);
          const prevTotal = parseFloat(wallet.balance || 0);
          updatedWallet = await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
            data: {
              [balanceField]: prevField + walletDelta,
              balance: prevTotal + walletDelta,
            },
          });
        }

        return { updatedTx, updatedWallet };
      });

      // Audit log (best-effort)
      try {
        await strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
          data: {
            adminUser: adminUser.id,
            action: 'transaction_edit',
            targetUser: existing.users_permissions_user?.id,
            details: {
              transactionId: id,
              changedFields: Object.keys(updateData),
              previousStatus: existing.transactionStatus,
              newStatus: transactionStatus !== undefined ? transactionStatus : existing.transactionStatus,
              walletDelta,
              walletId: wallet?.id || null,
              adminNotes: adminNotes || null,
            },
            ipAddress: ctx.request.ip,
            userAgent: ctx.request.headers['user-agent'],
          },
        });
      } catch (auditErr) {
        console.error('[ADMIN TRANSACTION EDIT] Failed to write audit log:', auditErr.message);
      }

      // Real-time push when admin's transaction edit actually moved the wallet.
      // Emit on the TARGET user's channel (not admin's).
      if (walletDelta !== 0 && result.updatedWallet) {
        try {
          const targetUserId = existing.users_permissions_user?.id;
          if (targetUserId) {
            await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
              targetUserId,
              'admin_transaction_edit',
              {
                adminId: adminUser.id,
                transactionId: id,
                walletId: result.updatedWallet.id,
                walletDelta,
                fundSource: balanceField === 'promoBalance' ? 'promo_fund' : 'main_fund',
              }
            );
          }
        } catch (emitErr) {
          console.error('[ADMIN TRANSACTION EDIT] emitBalanceUpdate failed (non-fatal):', emitErr.message);
        }
      }

      // Affiliate commission: award on non-success→success flip, reverse
      // on success→non-success flip. Applies ONLY to deposits (the service
      // gate-checks type internally, so a change on any other row is a no-op).
      const commissionSvc = strapi.service('api::affiliate-commission.affiliate-commission');
      if (wasSettled && !willBeSettled) {
        commissionSvc.reverseOnRefund({
          originalDepositTxId: id,
          refundTxId: null,
          reason: `Admin ${adminUser.username || adminUser.id} flipped tx ${id} to ${transactionStatus}`,
        }).catch((e) => console.warn('[ADMIN TRANSACTION EDIT] reverseOnRefund failed (non-fatal):', e.message));
      } else if (!wasSettled && willBeSettled) {
        commissionSvc.awardOnDeposit({ depositTransactionId: id })
          .catch((e) => console.warn('[ADMIN TRANSACTION EDIT] awardOnDeposit failed (non-fatal):', e.message));
      }

      ctx.send({
        data: result.updatedTx,
        walletDelta,
        wallet: result.updatedWallet
          ? {
              id: result.updatedWallet.id,
              mainBalance: parseFloat(result.updatedWallet.mainBalance || 0),
              promoBalance: parseFloat(result.updatedWallet.promoBalance || 0),
              balance: parseFloat(result.updatedWallet.balance || 0),
            }
          : null,
      });

    } catch (error) {
      console.error('[ADMIN TRANSACTION EDIT ERROR]', error);
      return ctx.internalServerError('Failed to update transaction');
    }
  },

  /**
   * Update transaction status (admin action)
   */
  async updateStatus(ctx) {
    try {
      const { id } = ctx.params;
      const { transactionStatus, adminNotes } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} updating transaction ${id} status to ${transactionStatus}`);

      const updatedTransaction = await strapi.entityService.update('api::transaction.transaction', id, {
        data: {
          transactionStatus,
          adminNotes,
          lastStatusUpdate: new Date(),
          processedBy: ctx.state.user.id
        },
        populate: ['users_permissions_user', 'order']
      });

      ctx.send({
        data: updatedTransaction
      });

    } catch (error) {
      console.error('[ADMIN TRANSACTION UPDATE STATUS ERROR]', error);
      return ctx.internalServerError('Failed to update transaction status');
    }
  },

  /**
   * Approve transaction (admin action)
   */
  async approve(ctx) {
    try {
      const { id } = ctx.params;
      const { notes } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} approving transaction ${id}`);

      const updatedTransaction = await strapi.entityService.update('api::transaction.transaction', id, {
        data: {
          transactionStatus: 'completed',
          adminNotes: notes,
          approvedAt: new Date(),
          approvedBy: ctx.state.user.id
        },
        populate: ['users_permissions_user', 'order']
      });

      // If this is a payment transaction, update user wallet
      if (updatedTransaction.type === 'payment') {
        const targetUserId = updatedTransaction.users_permissions_user.id;
        const wallet = await strapi.controller('api::user-wallet.user-wallet')
          .getOrCreateWallet(targetUserId);

        await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
          data: {
            balance: parseFloat(wallet.balance) + parseFloat(updatedTransaction.amount)
          }
        });

        // Real-time push so the target user sees the admin-approved credit
        // without refreshing. Best-effort.
        try {
          await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(
            targetUserId,
            'admin_transaction_approve',
            { adminId: ctx.state.user.id, transactionId: id, walletId: wallet.id, amount: parseFloat(updatedTransaction.amount) }
          );
        } catch (emitErr) {
          console.error('[ADMIN TRANSACTION APPROVE] emitBalanceUpdate failed (non-fatal):', emitErr.message);
        }
      }

      ctx.send({
        data: updatedTransaction
      });

    } catch (error) {
      console.error('[ADMIN TRANSACTION APPROVE ERROR]', error);
      return ctx.internalServerError('Failed to approve transaction');
    }
  },

  /**
   * Reject transaction (admin action)
   */
  async reject(ctx) {
    try {
      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} rejecting transaction ${id}. Reason: ${reason}`);

      const updatedTransaction = await strapi.entityService.update('api::transaction.transaction', id, {
        data: {
          transactionStatus: 'failed',
          failureReason: reason,
          rejectedAt: new Date(),
          rejectedBy: ctx.state.user.id
        },
        populate: ['users_permissions_user', 'order']
      });

      ctx.send({
        data: updatedTransaction
      });

    } catch (error) {
      console.error('[ADMIN TRANSACTION REJECT ERROR]', error);
      return ctx.internalServerError('Failed to reject transaction');
    }
  },

  /**
   * Get transaction statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      const txQuery = strapi.db.query('api::transaction.transaction');
      // Settled = money has actually moved. Deposits/refunds/promos land at
      // 'success'; withdrawals/payouts settle to 'paid' via the
      // withdrawal-request lifecycle. Both belong in the totals.
      const SETTLED_STATUSES = ['success', 'paid'];
      const SETTLED = { transactionStatus: { $in: SETTLED_STATUSES } };

      const [total, pending, settled, failed] = await Promise.all([
        txQuery.count(),
        txQuery.count({ where: { transactionStatus: 'pending' } }),
        txQuery.count({ where: SETTLED }),
        txQuery.count({ where: { transactionStatus: 'failed' } }),
      ]);

      // Sum settled `amount` for a given type — used to populate the card values
      const sumByType = async (type) => {
        const rows = await txQuery.findMany({
          where: { ...SETTLED, type },
          select: ['amount'],
        });
        return rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
      };

      const [deposits, withdrawals, refunds, fees] = await Promise.all([
        sumByType('deposit'),
        sumByType('withdrawal'),
        sumByType('refund'),
        sumByType('fee'),
      ]);

      // Net revenue = inflows minus outflows on settled rows.
      // Refunds are subtracted because they reverse prior deposits.
      const netRevenue = deposits - withdrawals - refunds;

      // Total volume (sum of all settled amounts, regardless of direction)
      const allSettled = await txQuery.findMany({
        where: SETTLED,
        select: ['amount', 'gateway'],
      });
      const totalVolume = allSettled.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

      // Gateway breakdown (count per gateway, settled only)
      const methodBreakdown = {};
      allSettled.forEach((tx) => {
        const method = tx.gateway || 'unknown';
        methodBreakdown[method] = (methodBreakdown[method] || 0) + 1;
      });

      // New this month
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);
      const newThisMonth = await txQuery.count({
        where: { createdAt: { $gte: thisMonth.toISOString() } },
      });

      const round2 = (n) => Math.round(n * 100) / 100;

      ctx.send({
        // counts
        total,
        pending,
        success: settled,
        completed: settled, // backward-compat alias
        failed,
        newThisMonth,
        // amounts (numbers, not strings — frontend uses .toLocaleString())
        deposits: round2(deposits),
        withdrawals: round2(withdrawals),
        refunds: round2(refunds),
        fees: round2(fees),
        netRevenue: round2(netRevenue),
        totalVolume: round2(totalVolume),
        // breakdown
        methodBreakdown,
      });

    } catch (error) {
      console.error('[ADMIN TRANSACTION STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch transaction statistics');
    }
  },

  /**
   * Generate transaction report
   */
  async generateReport(ctx) {
    try {
      const { startDate, endDate, format = 'json' } = ctx.query;

      const filters = {};
      if (startDate && endDate) {
        filters.createdAt = {
          $gte: startDate,
          $lte: endDate
        };
      }

      const transactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters,
        sort: 'createdAt:desc',
        populate: {
          users_permissions_user: {
            fields: ['id', 'username', 'email']
          },
          order: {
            fields: ['id', 'description']
          }
        }
      });

      if (format === 'csv') {
        // Convert to CSV format
        const csv = transactions.map(t => ({
          id: t.id,
          date: t.createdAt,
          user: t.users_permissions_user?.email || 'N/A',
          amount: t.amount,
          status: t.transactionStatus,
          type: t.type,
          gateway: t.gateway,
          order: t.order?.id || 'N/A'
        }));

        ctx.set('Content-Type', 'text/csv');
        ctx.set('Content-Disposition', 'attachment; filename="transactions-report.csv"');

        const csvString = [
          Object.keys(csv[0]).join(','),
          ...csv.map(row => Object.values(row).join(','))
        ].join('\n');

        ctx.body = csvString;
      } else {
        ctx.send({
          data: transactions,
          summary: {
            total: transactions.length,
            totalAmount: transactions.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0)
          }
        });
      }

    } catch (error) {
      console.error('[ADMIN TRANSACTION REPORT ERROR]', error);
      return ctx.internalServerError('Failed to generate transaction report');
    }
  }

}));
