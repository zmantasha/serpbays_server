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
        console.log('Request by unauthenticated user');
        return ctx.unauthorized('Authentication required');
      }
      
      console.log('User authenticated with ID:', ctx.state.user.id);
      
      // Get the request body
      const { amount, method, details } = ctx.request.body.data || ctx.request.body;
      
      console.log('Received withdrawal request:', { amount, method, details: JSON.stringify(details) });
      
      // Validate required fields
      if (!amount || !method || !details) {
        console.log('Missing required fields:', { amount, method, details: !!details });
        return ctx.badRequest('Missing required fields: amount, method, and details are required');
      }
      
      // Ensure details is a valid JSON object
      let formattedDetails = details;
      if (typeof details === 'string') {
        try {
          formattedDetails = { value: details };
        } catch (e) {
          console.error('Error formatting details:', e);
          return ctx.badRequest('Details must be a valid JSON object');
        }
      }
      
      // Validate amount is a positive number
      const requestAmount = parseFloat(amount);
      if (isNaN(requestAmount) || requestAmount <= 0) {
        console.log('Invalid amount:', amount);
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
        console.log('Publisher wallet not found for user:', ctx.state.user.id);
        return ctx.badRequest('Publisher wallet not found');
      }
      
      console.log('Found publisher wallet:', { 
        id: publisherWallet.id, 
        balance: publisherWallet.balance 
      });
      
      try {
        // Get available balance using direct calculation rather than another controller method
        // Get completed orders not already used in withdrawals
        const completedOrders = await strapi.db.query('api::order.order').findMany({
          where: {
            publisher: ctx.state.user.id,
            orderStatus: 'approved'
          }
        });
        
        console.log(`Found ${completedOrders.length} completed orders for publisher ${ctx.state.user.id}`);
        
        const completedOrderIds = new Set(completedOrders.map(order => order.id));
        
        // Get all transactions to identify those already processed for withdrawal
        const allTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
          filters: {
            user_wallet: { id: publisherWallet.id },
          },
          populate: ['order'],
          sort: { createdAt: 'desc' }
        });
        
        // Identify orders that have already been processed for withdrawal
        const processedOrderIds = new Set();
        allTransactions.forEach(tx => {
          if (tx.description && tx.description.includes('Included in withdrawal request') && tx.order) {
            processedOrderIds.add(tx.order.id);
          }
        });
        
        console.log(`Found ${processedOrderIds.size} orders already processed for withdrawal`);
        
        // Filter for available transactions
        const availableTransactions = allTransactions.filter(tx => {
          // Keep only escrow_release transactions
          if (tx.type !== 'escrow_release') return false;
          
          // Must have a valid order
          if (!tx.order || !tx.order.id) return false;
          
          // Order must be in the completed orders list
          if (!completedOrderIds.has(tx.order.id)) return false;
          
          // Order must not have been already processed for withdrawal
          if (processedOrderIds.has(tx.order.id)) return false;
          
          // Ensure transaction status is valid
          if (tx.transactionStatus !== 'pending' && tx.transactionStatus !== 'success') return false;
          
          return true;
        });
        
        console.log(`Found ${availableTransactions.length} available transactions after filtering`);
        
        // Group transactions by order to avoid double-counting
        const orderMap = new Map();
        
        availableTransactions.forEach(tx => {
          const orderId = tx.order?.id;
          if (!orderId) return;
          
          // Only keep the latest transaction for each order
          if (!orderMap.has(orderId) || 
              new Date(tx.createdAt) > new Date(orderMap.get(orderId).createdAt)) {
            orderMap.set(orderId, tx);
          }
        });
        
        // Get the valid transactions (one per order)
        const validTransactions = Array.from(orderMap.values());
        
        // Calculate the total from completed orders only
        const completedOrdersAmount = validTransactions.reduce((total, tx) => {
          return total + parseFloat(tx.amount || 0);
        }, 0);
        
        // Get wallet balance separately
        const walletBalance = parseFloat(publisherWallet.balance || 0);
        
        // Total available (combining wallet balance with completed orders)
        const totalAvailable = walletBalance + completedOrdersAmount;
        
        console.log('Balance calculation:', {
          walletBalance,
          completedOrdersAmount,
          totalAvailable,
          validTransactionCount: validTransactions.length
        });
        
        // Check if user has sufficient balance
        if (totalAvailable < requestAmount) {
          return ctx.badRequest(`Insufficient funds. Available balance: ${totalAvailable}`);
        }
        
        // Continue with the withdrawal process...  
        const completedOrdersTransactions = validTransactions;
      
      // Create the withdrawal request
      const withdrawalRequest = await strapi.entityService.create('api::withdrawal-request.withdrawal-request', {
        data: {
          publisher: ctx.state.user.id,
          amount: requestAmount,
          method,
          details: formattedDetails,
          withdrawal_status: 'pending'
        }
      });
      
      console.log('Created withdrawal request:', withdrawalRequest.id);
      
      // Process all funds as if they're from completed orders since we're combining the balances
      let amountFromCompletedOrders = requestAmount;
      
      // Update wallet balance if needed
      if (publisherWallet.balance > 0) {
        const amountFromWallet = Math.min(publisherWallet.balance, requestAmount);
        
        // Update wallet balance - reduce the wallet balance but add the same amount to escrow
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: publisherWallet.id },
          data: {
            balance: publisherWallet.balance - amountFromWallet,
            escrowBalance: publisherWallet.escrowBalance + requestAmount
          }
        });
        
        console.log(`Updated wallet: reduced balance by ${amountFromWallet}, added ${requestAmount} to escrow`);
        
        // If the entire withdrawal amount comes from the wallet, we're done with transactions
        if (amountFromWallet >= requestAmount) {
          // Create a transaction record for the withdrawal request
          await strapi.entityService.create('api::transaction.transaction', {
            data: {
              type: 'escrow_hold',
              amount: requestAmount,
              netAmount: requestAmount,
              fee: 0,
              transactionStatus: 'pending',
              gateway: method,
              gatewayTransactionId: `withdrawal_req_${withdrawalRequest.id}_${Date.now()}`,
              description: `Withdrawal request via ${method} (from wallet)`,
              user_wallet: publisherWallet.id
            }
          });
          
          return {
            data: withdrawalRequest,
            meta: {
              message: 'Withdrawal request created successfully from wallet balance',
            }
          };
        }
      }
      
      // If we're here, we need to use completed orders transactions
      if (completedOrdersTransactions.length > 0) {
        // Sort transactions by date (oldest first)
        completedOrdersTransactions.sort((a, b) => {
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
        
        // Keep track of orders we've processed to avoid double-counting
        const processedOrderIds = new Set();
        
        // Track how much we still need to process
        let amountRemaining = requestAmount;
        
        // Process transactions until we've covered the required amount
        for (const tx of completedOrdersTransactions) {
          if (amountRemaining <= 0) break;
          
          // Skip if no order or if this order has already been processed
          if (!tx.order || !tx.order.id || processedOrderIds.has(tx.order.id)) continue;
          
          // Mark this order as processed
          processedOrderIds.add(tx.order.id);
          
          const txAmount = parseFloat(tx.amount);
          const amountToUse = Math.min(txAmount, amountRemaining);
          
          console.log(`Processing transaction ${tx.id} from order ${tx.order.id} - amount: ${txAmount}, using: ${amountToUse}`);
          
          // Update transaction status and mark it as included in this withdrawal request
          // Create a completely new description with a standardized format to ensure consistency
          let baseDescription = tx.description || '';
          // Remove any existing withdrawal request references to avoid duplicates
          if (baseDescription.includes(' - Included in withdrawal request')) {
            baseDescription = baseDescription.split(' - Included in withdrawal request')[0];
          }
          
          // Apply the standardized format
          await strapi.entityService.update('api::transaction.transaction', tx.id, {
            data: {
              transactionStatus: 'success', // Mark as success to indicate it's been used
              description: `${baseDescription} - Included in withdrawal request #${withdrawalRequest.id}`
            }
          });
          
          amountRemaining -= amountToUse;
          
          // If we didn't use the full transaction amount, update the existing transaction instead of creating a new one
          if (amountToUse < txAmount) {
            console.log(`Updating transaction ${tx.id} - reducing amount from ${txAmount} to ${txAmount - amountToUse}`);
            
            // Update the existing transaction with the reduced amount
            await strapi.entityService.update('api::transaction.transaction', tx.id, {
              data: {
                amount: txAmount - amountToUse,
                netAmount: txAmount - amountToUse,
                description: `Remaining balance (${txAmount - amountToUse}) from ${baseDescription.split(' - ')[0]}`,
                transactionStatus: 'pending' // Reset transaction status for the remaining amount
              }
            });
            
            // Create a new transaction for the withdrawn amount
            await strapi.entityService.create('api::transaction.transaction', {
              data: {
                type: 'escrow_release',
                amount: amountToUse,
                netAmount: amountToUse,
                fee: 0,
                transactionStatus: 'success', // Important: Mark as success to indicate it's been used
                description: `${baseDescription.split(' - ')[0]} - Included in withdrawal request #${withdrawalRequest.id}`,
                user_wallet: publisherWallet.id,
                order: tx.order.id
              }
            });
            
            console.log(`Transaction ${tx.id} updated with remaining balance of ${txAmount - amountToUse}`);
          }
        }
      }
      
      // Create a transaction record for the withdrawal request
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'escrow_hold',
          amount: requestAmount,
          netAmount: requestAmount,
          fee: 0,
          transactionStatus: 'pending',
          gateway: method,
          gatewayTransactionId: `withdrawal_req_${withdrawalRequest.id}_${Date.now()}`,
          description: `Withdrawal request via ${method}`,
          user_wallet: publisherWallet.id
        }
      });
      
      return {
        data: withdrawalRequest,
        meta: {
          message: 'Withdrawal request created successfully',
        }
      };
      
      } catch (balanceError) {
        console.error('Error calculating available balance:', balanceError);
        return ctx.badRequest('Failed to calculate available balance for withdrawal', { 
          error: balanceError.message 
        });
      }
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
      
      // Find all withdrawal requests for the current user using Strapi entity service
      // This ensures we get the data directly from Strapi without filtering
      const withdrawalRequests = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: { 
          publisher: { id: ctx.state.user.id } 
        },
        sort: { createdAt: 'desc' }
      });
      
      console.log('Withdrawal requests retrieved:', withdrawalRequests.length);
      
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
      if (withdrawalRequest.withdrawal_status !== 'pending') {
        return ctx.badRequest(`Withdrawal request is already ${withdrawalRequest.withdrawal_status}`);
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
            withdrawal_status: 'paid'
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
      if (withdrawalRequest.withdrawal_status !== 'pending') {
        return ctx.badRequest(`Withdrawal request is already ${withdrawalRequest.withdrawal_status}`);
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
          withdrawal_status: 'denied',
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
      
      // Get publisher wallet using Strapi entity service
      const publisherWallets = await strapi.entityService.findMany('api::user-wallet.user-wallet', {
        filters: { 
          users_permissions_user: { id: userId },
          type: 'publisher'
        }
      });
      
      const publisherWallet = publisherWallets?.[0]; // Get the first wallet if one exists
      
      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found');
      }
      
      // STEP 1: Get all completed orders with their total amount
      // This will be our source of truth for available funds
      const completedOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: userId,
          orderStatus: 'approved' // Only count approved orders
        }
      });
      
      console.log(`Found ${completedOrders.length} completed orders for publisher ${userId}`);
      
      // Create a set of completed order IDs for later filtering
      const completedOrderIds = new Set(completedOrders.map(order => order.id));
      
      // STEP 2: Get all withdrawal requests, including their related transactions
      // to properly exclude funds that have already been withdrawn
      const withdrawalRequests = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId },
          withdrawal_status: { $in: ['pending', 'approved', 'paid'] } // Include all non-denied withdrawals
        },
        sort: { createdAt: 'desc' }
      });
      
      // Get all transactions in the system for this user
      const allTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters: {
          user_wallet: { id: publisherWallet.id },
        },
        populate: ['order'],
        sort: { createdAt: 'desc' }
      });
      
      console.log(`Found ${allTransactions.length} total transactions`);
      
      // Identify orders and transactions that have already been processed for withdrawal
      const processedOrderIds = new Set();
      const processedTransactionIds = new Set();
      
      // Mark transactions as processed if they contain withdrawal request references
      allTransactions.forEach(tx => {
        // If the transaction description mentions a withdrawal request, mark it as processed
        if (tx.description && tx.description.includes('Included in withdrawal request')) {
          if (tx.order && tx.order.id) {
            processedOrderIds.add(tx.order.id);
          }
          processedTransactionIds.add(tx.id);
        }
        
        // Also check transaction status - transactions marked as 'success' for escrow_release
        // have been used in withdrawals
        if (tx.type === 'escrow_release' && tx.transactionStatus === 'success') {
          if (tx.order && tx.order.id) {
            processedOrderIds.add(tx.order.id);
          }
          processedTransactionIds.add(tx.id);
        }
      });
      
      console.log(`Found ${processedOrderIds.size} orders already processed for withdrawal`);
      console.log(`Found ${processedTransactionIds.size} transactions already used in withdrawals`);
      
      // STEP 3: Apply more stringent filtering to find truly available transactions
      const availableTransactions = allTransactions.filter(tx => {
        // Only consider escrow_release transactions
        if (tx.type !== 'escrow_release') return false;
        
        // Skip transactions already marked as used
        if (processedTransactionIds.has(tx.id)) return false;
        
        // Must have a valid order
        if (!tx.order || !tx.order.id) return false;
        
        // Order must be in the completed orders list
        if (!completedOrderIds.has(tx.order.id)) return false;
        
        // Order must not have been already processed for withdrawal
        if (processedOrderIds.has(tx.order.id)) return false;
        
        // Ensure transaction status is valid (only pending ones are available)
        if (tx.transactionStatus !== 'pending') return false;
        
        // The description should not contain any withdrawal references
        if (tx.description && tx.description.includes('Included in withdrawal request')) return false;
        
        // This transaction is available for withdrawal
        return true;
      });
      
      console.log(`Found ${availableTransactions.length} available transactions after strict filtering`);
      
      // Log the available transactions for debugging
      availableTransactions.forEach(tx => {
        console.log(`Available tx: ID ${tx.id}, Order ${tx.order?.id}, Amount: ${tx.amount}, Status: ${tx.transactionStatus}`);
      });
      
      // STEP 4: Group transactions by order to avoid double-counting
      const orderMap = new Map();
      
      availableTransactions.forEach(tx => {
        const orderId = tx.order?.id;
        if (!orderId) return;
        
        // Only keep the latest transaction for each order
        if (!orderMap.has(orderId) || 
            new Date(tx.createdAt) > new Date(orderMap.get(orderId).createdAt)) {
          orderMap.set(orderId, tx);
        }
      });
      
      // Get the valid transactions (one per order)
      const validTransactions = Array.from(orderMap.values());
      
      console.log(`Found ${validTransactions.length} final valid transactions after deduplication`);
      
      // STEP 5: Calculate the final balances
      // Calculate the total from completed orders only
      const completedOrdersAmount = validTransactions.reduce((total, tx) => {
        return total + parseFloat(tx.amount || 0);
      }, 0);
      
      // Get wallet balance separately
      const walletBalance = parseFloat(publisherWallet.balance || 0);
      
      // Total available (combining wallet balance with completed orders)
      const totalAvailable = walletBalance + completedOrdersAmount;
      
      console.log('Final balance calculation:', {
        walletBalance,
        completedOrdersAmount,
        totalAvailable,
        validTransactionCount: validTransactions.length
      });
      
      // STEP 6: Return balance data with proper separation of values
      return {
        data: {
          walletBalance, // Keep the actual wallet balance
          completedOrdersAmount, // Keep this as just the completed orders amount
          totalAvailable, // This is the sum of wallet + completed orders
          completedOrders: validTransactions,
          transactionCount: validTransactions.length,
          totalEarnings: withdrawalRequests.reduce((sum, wr) => sum + parseFloat(wr.amount || 0), 0) + totalAvailable // Total lifetime earnings
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


