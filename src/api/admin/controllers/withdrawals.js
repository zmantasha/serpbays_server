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
            fields: ['id', 'username', 'email', 'firstName', 'lastName', 'phoneNumber']
          },
          user_wallet: true
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

      // NOTE: Wallet balance is not modified here during approval.
      // The pendingWithdrawalBalance will only be reduced when the withdrawal is marked as paid.
      // Approval is just an internal admin confirmation step.

      // NOTE: No transaction created here. Transaction will only be created when marked as paid.
      // Approval is an internal admin action, not a financial transaction.

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
          denial_reason: reason,
          rejected_at: new Date(),
          rejected_by: ctx.state.user.id,
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
   * Mark withdrawal as paid (admin action)
   */
  async markAsPaid(ctx) {
    try {
      const { id } = ctx.params;
      const { paymentReference, paymentNotes, paymentDate } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} marking withdrawal ${id} as paid`);

      // Get withdrawal request details
      const withdrawal = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });

      if (!withdrawal) {
        return ctx.notFound('Withdrawal request not found');
      }

      if (withdrawal.withdrawal_status !== 'approved') {
        return ctx.badRequest('Withdrawal request must be approved before marking as paid');
      }

      // Get or create the publisher's wallet using the correct method
      const publisherWallet = await strapi.controller('api::user-wallet.user-wallet')
        .getOrCreateWallet(withdrawal.publisher.id);
      
      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found');
      }

      const currentPendingBalance = parseFloat(publisherWallet.pendingWithdrawalBalance || 0);
      const withdrawalAmount = parseFloat(withdrawal.amount);
      
      if (currentPendingBalance < withdrawalAmount) {
        return ctx.badRequest(`Insufficient pending withdrawal balance. Available: ${currentPendingBalance}, Required: ${withdrawalAmount}`);
      }

      // Use database transaction to ensure atomicity
      const trx = await strapi.db.connection.transaction();
      
      try {
        // Update withdrawal request
        const updatedWithdrawal = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
          data: { 
            withdrawal_status: 'paid',
            paymentReference,
            paymentNotes,
            paidAt: paymentDate ? new Date(paymentDate) : new Date(),
            paidBy: ctx.state.user.id,
            processedAt: new Date()
          },
          populate: ['publisher']
        });

        // Update wallet - reduce pending withdrawal balance
        await strapi.entityService.update('api::user-wallet.user-wallet', publisherWallet.id, {
          data: {
            pendingWithdrawalBalance: parseFloat(publisherWallet.pendingWithdrawalBalance) - parseFloat(withdrawal.amount)
          }
        });

        // Update the existing withdrawal transaction instead of creating a new one
        const existingTransaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: {
            users_permissions_user: withdrawal.publisher.id,
            type: 'withdrawal',
            description: { $contains: `Withdrawal request #${id}` }
          },
          orderBy: { id: 'desc' }
        });

        if (existingTransaction) {
          // Update the existing withdrawal transaction to paid status
          await strapi.entityService.update('api::transaction.transaction', existingTransaction.id, {
            data: {
              transactionStatus: 'paid',
              external_transaction_id: paymentReference,
              payment_notes: paymentNotes,
              description: `${existingTransaction.description} - Payment completed via ${withdrawal.method || 'Manual'}`
            }
          });
          console.log(`✅ Updated existing withdrawal transaction ${existingTransaction.id} to paid status`);
        } else {
          console.log(`⚠️ No existing withdrawal transaction found for withdrawal #${id}, creating new one`);
          // Fallback: create a new transaction if none exists (shouldn't happen in normal flow)
          await strapi.entityService.create('api::transaction.transaction', {
            data: {
              users_permissions_user: withdrawal.publisher.id,
              type: 'withdrawal',
              transactionStatus: 'paid',
              amount: parseFloat(withdrawal.amount),
              netAmount: parseFloat(withdrawal.amount),
              gateway: withdrawal.method || 'system',
              gatewayTransactionId: paymentReference || `WP-${id}-${Date.now()}`,
              description: `Withdrawal request #${id} - Payment completed via ${withdrawal.method || 'Manual'}`,
              fee: 0,
              user_wallet: publisherWallet.id,
              external_transaction_id: paymentReference,
              payment_notes: paymentNotes
            }
          });
        }

        // Commit the transaction
        await trx.commit();

        ctx.send({
          data: updatedWithdrawal
        });
      } catch (transactionError) {
        // Rollback the transaction
        await trx.rollback();
        console.error('[ADMIN WITHDRAWAL MARK AS PAID TRANSACTION ERROR]', transactionError);
        throw transactionError;
      }

    } catch (error) {
      console.error('[ADMIN WITHDRAWAL MARK AS PAID ERROR]', error);
      return ctx.internalServerError('Failed to mark withdrawal as paid');
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
