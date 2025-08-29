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
      
      // Search filter
      if (search) {
        filters.$or = [
          { transactionId: { $containsi: search } },
          { id: { $eq: parseInt(search) || 0 } }
        ];
      }

      // Status filter
      if (status) {
        filters.transactionStatus = status;
      }

      // Type filter
      if (type) {
        filters.transactionType = type;
      }

      // Gateway filter
      if (gateway) {
        filters.gateway = gateway;
      }

      // User filter
      if (userId) {
        filters.users_permissions_user = userId;
      }

      // Get transactions with pagination
      const transactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters,
        sort,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize)
        },
        populate: {
          users_permissions_user: {
            fields: ['id', 'username', 'email']
          },
          order: {
            fields: ['id', 'description']
          }
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::transaction.transaction').count({ where: filters });

      ctx.send({
        data: transactions,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount: Math.ceil(total / pageSize),
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
        data: transaction
      });

    } catch (error) {
      console.error('[ADMIN TRANSACTION FIND ONE ERROR]', error);
      return ctx.internalServerError('Failed to fetch transaction details');
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
      if (updatedTransaction.transactionType === 'payment') {
        const wallet = await strapi.controller('api::user-wallet.user-wallet')
          .getOrCreateWallet(updatedTransaction.users_permissions_user.id);
        
        await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
          data: {
            balance: parseFloat(wallet.balance) + parseFloat(updatedTransaction.amount)
          }
        });
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
      const total = await strapi.db.query('api::transaction.transaction').count();
      const pending = await strapi.db.query('api::transaction.transaction').count({
        where: { transactionStatus: 'pending' }
      });
      const completed = await strapi.db.query('api::transaction.transaction').count({
        where: { transactionStatus: 'completed' }
      });
      const failed = await strapi.db.query('api::transaction.transaction').count({
        where: { transactionStatus: 'failed' }
      });

      // Calculate total volume
      const volumeData = await strapi.db.query('api::transaction.transaction').findMany({
        where: { transactionStatus: 'completed' },
        select: ['amount']
      });
      const totalVolume = volumeData.reduce((sum, transaction) => {
        return sum + parseFloat(transaction.amount || 0);
      }, 0);

      // Get payment method breakdown
      const paymentMethods = await strapi.db.query('api::transaction.transaction').findMany({
        where: { transactionStatus: 'completed' },
        select: ['gateway']
      });
      
      const methodBreakdown = {};
      paymentMethods.forEach(transaction => {
        const method = transaction.gateway || 'unknown';
        methodBreakdown[method] = (methodBreakdown[method] || 0) + 1;
      });

      // Get new transactions this month
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);

      const newThisMonth = await strapi.db.query('api::transaction.transaction').count({
        where: {
          createdAt: {
            $gte: thisMonth.toISOString()
          }
        }
      });

      ctx.send({
        total,
        pending,
        completed,
        failed,
        totalVolume: totalVolume.toFixed(2),
        methodBreakdown,
        newThisMonth
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
