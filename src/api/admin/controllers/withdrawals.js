'use strict';

/**
 * Admin Withdrawals Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::withdrawal-request.withdrawal-request', ({ strapi }) => ({

  /**
   * Get all withdrawal requests with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const { 
        page = 1, 
        pageSize = 20, 
        sort = 'createdAt:desc',
        search = '',
        status = '',
        userId = ''
      } = ctx.query;

      // Build filters
      const filters = {};
      
      // Search filter
      if (search) {
        filters.$or = [
          { id: { $eq: parseInt(search) || 0 } }
        ];
      }

      // Status filter
      if (status) {
        filters.withdrawal_status = status;
      }

      // User filter
      if (userId) {
        filters.publisher = userId;
      }

      // Get withdrawal requests with pagination
      const withdrawals = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters,
        sort,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize)
        },
        populate: {
          publisher: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          }
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::withdrawal-request.withdrawal-request').count({ where: filters });

      ctx.send({
        data: withdrawals,
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
      console.error('[ADMIN WITHDRAWALS FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch withdrawal requests');
    }
  },

  /**
   * Get single withdrawal request with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;

      const withdrawal = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: {
          publisher: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName', 'phoneNumber'],
            populate: ['user_wallet']
          }
        }
      });

      if (!withdrawal) {
        return ctx.notFound('Withdrawal request not found');
      }

      ctx.send({
        data: withdrawal
      });

    } catch (error) {
      console.error('[ADMIN WITHDRAWAL FIND ONE ERROR]', error);
      return ctx.internalServerError('Failed to fetch withdrawal request details');
    }
  },

  /**
   * Approve withdrawal request (admin action)
   */
  async approve(ctx) {
    try {
      const { id } = ctx.params;
      const { adminNotes, paymentReference } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} approving withdrawal ${id}`);

      // Get withdrawal request details
      const withdrawal = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });

      if (!withdrawal) {
        return ctx.notFound('Withdrawal request not found');
      }

      if (withdrawal.withdrawal_status !== 'pending') {
        return ctx.badRequest('Withdrawal request has already been processed');
      }

      // Update withdrawal request
      const updatedWithdrawal = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
        data: { 
          withdrawal_status: 'approved',
          adminNotes,
          paymentReference,
          approvedAt: new Date(),
          approvedBy: ctx.state.user.id,
          processedAt: new Date()
        },
        populate: ['publisher']
      });

      // Note: No balance deduction here - amount stays in pendingWithdrawalBalance
      // until the withdrawal is actually paid out

      ctx.send({
        data: updatedWithdrawal
      });

    } catch (error) {
      console.error('[ADMIN WITHDRAWAL APPROVE ERROR]', error);
      return ctx.internalServerError('Failed to approve withdrawal request');
    }
  },

  /**
   * Reject withdrawal request (admin action)
   */
  async reject(ctx) {
    try {
      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} rejecting withdrawal ${id}. Reason: ${reason}`);

      // Get withdrawal request details
      const withdrawal = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });

      if (!withdrawal) {
        return ctx.notFound('Withdrawal request not found');
      }

      if (withdrawal.withdrawal_status !== 'pending') {
        return ctx.badRequest('Withdrawal request has already been processed');
      }

      // Update withdrawal request
      const updatedWithdrawal = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
        data: { 
          withdrawal_status: 'denied',
          denial_reason: reason, // Changed to match lifecycle system
          rejectedAt: new Date(),
          rejectedBy: ctx.state.user.id,
          processedAt: new Date()
        },
        populate: ['publisher']
      });

      // Note: Wallet balance updates are handled automatically by the lifecycle system
      // when the withdrawal status changes to 'denied'

      ctx.send({
        data: updatedWithdrawal
      });

    } catch (error) {
      console.error('[ADMIN WITHDRAWAL REJECT ERROR]', error);
      return ctx.internalServerError('Failed to reject withdrawal request');
    }
  },

  /**
   * Pay withdrawal request (admin action) - actually deduct amount when paying
   */
  async pay(ctx) {
    try {
      const { id } = ctx.params;
      const { paymentReference, paymentMethod } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} paying withdrawal ${id}`);

      // Get withdrawal request details
      const withdrawal = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });

      if (!withdrawal) {
        return ctx.notFound('Withdrawal request not found');
      }

      if (withdrawal.withdrawal_status !== 'approved') {
        return ctx.badRequest('Withdrawal request must be approved before it can be paid');
      }

      // Update withdrawal request
      const updatedWithdrawal = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
        data: { 
          withdrawal_status: 'paid',
          paymentReference,
          paymentMethod,
          paidAt: new Date(),
          paidBy: ctx.state.user.id,
          processedAt: new Date()
        },
        populate: ['publisher']
      });

      // Note: Wallet balance updates are handled automatically by the lifecycle system
      // when the withdrawal status changes to 'paid'

      // Create transaction record for the actual payment
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          users_permissions_user: withdrawal.publisher.id,
          transactionType: 'withdrawal',
          transactionStatus: 'completed',
          amount: withdrawal.amount,
          currency: withdrawal.currency || 'USD',
          description: `Withdrawal paid - ${paymentReference || 'No reference'}`,
          transactionId: `WD-${id}-${Date.now()}`,
          paymentGateway: paymentMethod || 'manual',
          publishedAt: new Date()
        }
      });

      ctx.send({
        data: updatedWithdrawal
      });

    } catch (error) {
      console.error('[ADMIN WITHDRAWAL PAY ERROR]', error);
      return ctx.internalServerError('Failed to pay withdrawal request');
    }
  },

  /**
   * Get withdrawal statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      const total = await strapi.db.query('api::withdrawal-request.withdrawal-request').count();
      const pending = await strapi.db.query('api::withdrawal-request.withdrawal-request').count({
        where: { withdrawal_status: 'pending' }
      });
      const approved = await strapi.db.query('api::withdrawal-request.withdrawal-request').count({
        where: { withdrawal_status: 'approved' }
      });
      const denied = await strapi.db.query('api::withdrawal-request.withdrawal-request').count({
        where: { withdrawal_status: 'denied' }
      });
      const paid = await strapi.db.query('api::withdrawal-request.withdrawal-request').count({
        where: { withdrawal_status: 'paid' }
      });

      // Calculate total amount requested
      const totalAmountData = await strapi.db.query('api::withdrawal-request.withdrawal-request').findMany({
        select: ['amount', 'withdrawal_status']
      });
      
      const totalAmount = totalAmountData.reduce((sum, withdrawal) => {
        return sum + parseFloat(withdrawal.amount || 0);
      }, 0);

      const approvedAmount = totalAmountData
        .filter(w => w.withdrawal_status === 'approved')
        .reduce((sum, withdrawal) => sum + parseFloat(withdrawal.amount || 0), 0);

      const pendingAmount = totalAmountData
        .filter(w => w.withdrawal_status === 'pending')
        .reduce((sum, withdrawal) => sum + parseFloat(withdrawal.amount || 0), 0);

      // Get new withdrawal requests this month
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);

      const newThisMonth = await strapi.db.query('api::withdrawal-request.withdrawal-request').count({
        where: {
          createdAt: {
            $gte: thisMonth.toISOString()
          }
        }
      });

      ctx.send({
        totalRequests: total,
        total,
        pending,
        approved,
        denied,
        paid,
        totalAmount: totalAmount.toFixed(2),
        approvedAmount: approvedAmount.toFixed(2),
        pendingAmount: pendingAmount.toFixed(2),
        newThisMonth
      });

    } catch (error) {
      console.error('[ADMIN WITHDRAWAL STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch withdrawal statistics');
    }
  },

  /**
   * Bulk process withdrawals (admin action)
   */
  async bulkProcess(ctx) {
    try {
      const { withdrawalIds, action, notes } = ctx.request.body;

      if (!Array.isArray(withdrawalIds) || withdrawalIds.length === 0) {
        return ctx.badRequest('No withdrawal IDs provided');
      }

      if (!['approve', 'reject'].includes(action)) {
        return ctx.badRequest('Invalid action. Must be "approve" or "reject"');
      }

      const results = [];

      for (const withdrawalId of withdrawalIds) {
        try {
          if (action === 'approve') {
            await this.approve({
              params: { id: withdrawalId },
              request: { body: { adminNotes: notes } },
              state: ctx.state,
              send: () => {} // Mock send function
            });
          } else {
            await this.reject({
              params: { id: withdrawalId },
              request: { body: { reason: notes } },
              state: ctx.state,
              send: () => {} // Mock send function
            });
          }
          results.push({ id: withdrawalId, status: 'success' });
        } catch (error) {
          results.push({ id: withdrawalId, status: 'error', message: error.message });
        }
      }

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} bulk ${action} ${withdrawalIds.length} withdrawals`);

      ctx.send({
        message: `Bulk ${action} completed`,
        results
      });

    } catch (error) {
      console.error('[ADMIN WITHDRAWAL BULK PROCESS ERROR]', error);
      return ctx.internalServerError('Failed to process bulk withdrawal action');
    }
  }

}));
