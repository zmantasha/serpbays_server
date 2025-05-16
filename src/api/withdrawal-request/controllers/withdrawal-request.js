'use strict';

/**
 * withdrawal-request controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::withdrawal-request.withdrawal-request', ({ strapi }) => ({
  
  // Create a new withdrawal request
  async create(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      // Get the request body
      const { amount, method, details } = ctx.request.body.data || ctx.request.body;
      
      // Validate required fields
      if (!amount || !method || !details) {
        return ctx.badRequest('Missing required fields: amount, method, and details are required');
      }
      
      // Validate amount is a positive number
      const requestAmount = parseFloat(amount);
      if (isNaN(requestAmount) || requestAmount <= 0) {
        return ctx.badRequest('Amount must be a positive number');
      }
      
      // Get publisher wallet and check balance
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: ctx.state.user.id,
          type: 'publisher'
        }
      });
      
      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found');
      }
      
      // Get completed orders available for withdrawal
      const completedOrdersTransactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: { 
          user_wallet: publisherWallet.id,
          type: 'escrow_release',
          transactionStatus: 'pending'
        }
      });
      
      // Calculate available amount from completed orders
      const completedOrdersAmount = completedOrdersTransactions.reduce((total, tx) => {
        return total + parseFloat(tx.amount || 0);
      }, 0);
      
      // Total available balance (wallet + completed orders)
      const totalAvailable = publisherWallet.balance + completedOrdersAmount;
      
      // Check if user has sufficient balance
      if (totalAvailable < requestAmount) {
        return ctx.badRequest(`Insufficient funds. Available balance: ${totalAvailable}`);
      }
      
      // Create the withdrawal request
      const withdrawalRequest = await strapi.entityService.create('api::withdrawal-request.withdrawal-request', {
        data: {
          publisher: ctx.state.user.id,
          amount: requestAmount,
          method,
          details,
          status: 'pending'
        }
      });
      
      // Track how much we've processed so far
      let amountRemaining = requestAmount;
      let amountFromWallet = 0;
      let amountFromOrders = 0;
      
      // First use wallet balance
      if (publisherWallet.balance > 0) {
        amountFromWallet = Math.min(publisherWallet.balance, amountRemaining);
        amountRemaining -= amountFromWallet;
        
        // Update wallet balance
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: publisherWallet.id },
          data: {
            balance: publisherWallet.balance - amountFromWallet,
            escrowBalance: publisherWallet.escrowBalance + amountFromWallet
          }
        });
      }
      
      // If we still need more funds, use completed orders
      if (amountRemaining > 0 && completedOrdersTransactions.length > 0) {
        // Sort transactions by date (oldest first)
        completedOrdersTransactions.sort((a, b) => {
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
        
        // Process transactions until we've covered the required amount
        for (const tx of completedOrdersTransactions) {
          if (amountRemaining <= 0) break;
          
          const txAmount = parseFloat(tx.amount);
          const amountToUse = Math.min(txAmount, amountRemaining);
          
          // Update transaction status
          await strapi.entityService.update('api::transaction.transaction', tx.id, {
            data: {
              transactionStatus: 'processing',
              description: `${tx.description} - Included in withdrawal request #${withdrawalRequest.id}`
            }
          });
          
          // Add to order amount total
          amountFromOrders += amountToUse;
          amountRemaining -= amountToUse;
          
          // If we didn't use the full transaction amount, create a new transaction for the remainder
          if (amountToUse < txAmount) {
            await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'escrow_release',
                amount: txAmount - amountToUse,
                netAmount: txAmount - amountToUse,
                fee: 0,
                transactionStatus: 'pending',
                gateway: 'test',
                gatewayTransactionId: `remainder_${tx.id}_${Date.now()}`,
                description: `Remaining balance from order - ${tx.description}`,
                user_wallet: publisherWallet.id,
                order: tx.order
              }
            });
          }
        }
      }
      
      // Add to escrow balance
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: {
          escrowBalance: publisherWallet.escrowBalance + amountFromOrders
        }
      });
      
      // Create a transaction record for the withdrawal request
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'escrow_hold',
          amount: requestAmount,
          netAmount: requestAmount,
          fee: 0,
          transactionStatus: 'pending',
          gateway: method,
          description: `Withdrawal request via ${method} (${amountFromWallet} from wallet, ${amountFromOrders} from completed orders)`,
          user_wallet: publisherWallet.id
        }
      });
      
      return {
        data: withdrawalRequest,
        meta: {
          message: 'Withdrawal request created successfully',
          details: {
            amountFromWallet,
            amountFromOrders
          }
        }
      };
    } catch (error) {
      console.error('Error creating withdrawal request:', error);
      return ctx.badRequest('Failed to create withdrawal request', { error: error.message });
    }
  },
  
  // Get my withdrawal requests
  async getMyWithdrawals(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      // Find all withdrawal requests for the current user
      const withdrawalRequests = await strapi.db.query('api::withdrawal-request.withdrawal-request').findMany({
        where: { publisher: ctx.state.user.id },
        orderBy: { createdAt: 'desc' }
      });
      
      return {
        data: withdrawalRequests,
        meta: {
          count: withdrawalRequests.length
        }
      };
    } catch (error) {
      console.error('Error fetching withdrawal requests:', error);
      return ctx.internalServerError('An error occurred while fetching withdrawal requests');
    }
  },
  
  // Admin endpoint to approve a withdrawal request
  async approveWithdrawal(ctx) {
    try {
      // Check if user is authenticated and is an admin
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      // Check if user is an admin
      const { role } = ctx.state.user;
      if (!role || role.type !== 'admin') {
        return ctx.forbidden('Admin access required');
      }
      
      const { id } = ctx.params;
      
      // Get the withdrawal request
      const withdrawalRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });
      
      if (!withdrawalRequest) {
        return ctx.notFound('Withdrawal request not found');
      }
      
      // Check if the withdrawal request is already processed
      if (withdrawalRequest.status !== 'pending') {
        return ctx.badRequest(`Withdrawal request is already ${withdrawalRequest.status}`);
      }
      
      // Get publisher wallet
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'publisher'
        }
      });
      
      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found');
      }
      
      // Process the payment
      let paymentResult;
      
      try {
        // Process payment based on the method
        switch (withdrawalRequest.method) {
          case 'razorpay':
            paymentResult = await processRazorpayPayout(withdrawalRequest);
            break;
          case 'paypal':
            paymentResult = await processPaypalPayout(withdrawalRequest);
            break;
          case 'bank_transfer':
          case 'payoneer':
            // For manual methods, just mark as approved for now
            paymentResult = { 
              success: true, 
              transactionId: `manual_${Date.now()}`,
              message: 'Manual approval, payment to be processed separately'
            };
            break;
          default:
            throw new Error(`Unsupported payment method: ${withdrawalRequest.method}`);
        }
      } catch (paymentError) {
        console.error('Payment processing error:', paymentError);
        return ctx.badRequest('Payment processing failed', { error: paymentError.message });
      }
      
      // If payment was successful
      if (paymentResult.success) {
        // Update the withdrawal request
        const updatedRequest = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
          data: {
            status: 'paid'
          }
        });
        
        // Release from escrow
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: publisherWallet.id },
          data: {
            escrowBalance: publisherWallet.escrowBalance - withdrawalRequest.amount
          }
        });
        
        // Create a transaction record for the payout
        await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'payout',
            amount: withdrawalRequest.amount,
            netAmount: withdrawalRequest.amount,
            fee: 0,
            transactionStatus: 'success',
            gateway: withdrawalRequest.method,
            gatewayTransactionId: paymentResult.transactionId,
            description: `Payout via ${withdrawalRequest.method}`,
            user_wallet: publisherWallet.id
          }
        });
        
        return {
          data: updatedRequest,
          meta: {
            message: 'Withdrawal request approved and payment processed'
          }
        };
      } else {
        // If payment failed
        return ctx.badRequest('Payment processing failed', { error: paymentResult.message });
      }
    } catch (error) {
      console.error('Error approving withdrawal request:', error);
      return ctx.internalServerError('An error occurred while approving withdrawal request');
    }
  },
  
  // Admin endpoint to deny a withdrawal request
  async denyWithdrawal(ctx) {
    try {
      // Check if user is authenticated and is an admin
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      // Check if user is an admin
      const { role } = ctx.state.user;
      if (!role || role.type !== 'admin') {
        return ctx.forbidden('Admin access required');
      }
      
      const { id } = ctx.params;
      const { reason } = ctx.request.body;
      
      // Get the withdrawal request
      const withdrawalRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });
      
      if (!withdrawalRequest) {
        return ctx.notFound('Withdrawal request not found');
      }
      
      // Check if the withdrawal request is already processed
      if (withdrawalRequest.status !== 'pending') {
        return ctx.badRequest(`Withdrawal request is already ${withdrawalRequest.status}`);
      }
      
      // Get publisher wallet
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'publisher'
        }
      });
      
      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found');
      }
      
      // Update the withdrawal request
      const updatedRequest = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
        data: {
          status: 'denied',
          denialReason: reason
        }
      });
      
      // Return the funds to the publisher's balance
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: {
          balance: publisherWallet.balance + withdrawalRequest.amount,
          escrowBalance: publisherWallet.escrowBalance - withdrawalRequest.amount
        }
      });
      
      // Create a transaction record for the refund
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'refund',
          amount: withdrawalRequest.amount,
          netAmount: withdrawalRequest.amount,
          fee: 0,
          transactionStatus: 'failed',
          gateway: 'internal',
          description: `Withdrawal request denied: ${reason || 'No reason provided'}`,
          user_wallet: publisherWallet.id
        }
      });
      
      return {
        data: updatedRequest,
        meta: {
          message: 'Withdrawal request denied and funds returned to publisher'
        }
      };
    } catch (error) {
      console.error('Error denying withdrawal request:', error);
      return ctx.internalServerError('An error occurred while denying withdrawal request');
    }
  },
  
  // Get publisher available balance (including completed orders)
  async getAvailableBalance(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;
      
      // Get publisher wallet
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: userId,
          type: 'publisher'
        }
      });
      
      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found');
      }
      
      // Get total from completed orders (not yet withdrawn)
      const completedOrdersTransactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: { 
          user_wallet: publisherWallet.id,
          type: 'escrow_release',
          transactionStatus: 'pending'
        }
      });
      
      // Calculate total from completed orders
      const completedOrdersAmount = completedOrdersTransactions.reduce((total, tx) => {
        return total + parseFloat(tx.amount || 0);
      }, 0);
      
      // Get total from existing wallet balance
      const walletBalance = parseFloat(publisherWallet.balance || 0);
      
      // Calculate total available balance
      const totalAvailable = walletBalance + completedOrdersAmount;
      
      return {
        data: {
          walletBalance,
          completedOrdersAmount,
          totalAvailable,
          completedOrders: completedOrdersTransactions
        }
      };
    } catch (error) {
      console.error('Error getting available balance:', error);
      return ctx.badRequest('Failed to get available balance', { error: error.message });
    }
  }
}));

// Helper function to process Razorpay payout
async function processRazorpayPayout(withdrawalRequest) {
  // TODO: Implement Razorpay payout API integration
  console.log('MOCK: Processing Razorpay payout', withdrawalRequest);
  
  // Mock implementation
  return {
    success: true,
    transactionId: `razorpay_${Date.now()}`,
    message: 'Razorpay payout successfully processed'
  };
}

// Helper function to process PayPal payout
async function processPaypalPayout(withdrawalRequest) {
  // TODO: Implement PayPal payout API integration
  console.log('MOCK: Processing PayPal payout', withdrawalRequest);
  
  // Mock implementation
  return {
    success: true,
    transactionId: `paypal_${Date.now()}`,
    message: 'PayPal payout successfully processed'
  };
}
