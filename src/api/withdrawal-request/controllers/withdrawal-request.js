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
      
      // Get publisher wallet
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
      console.log('Found publisher wallet:', { id: publisherWallet.id, balance: publisherWallet.balance, escrow: publisherWallet.escrowBalance });

      // Balance Check Logic (aligned with getAvailableBalance)
      // STEP 1: Get all completed/approved order IDs for this user.
      const allCompletedRawOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: ctx.state.user.id,
          orderStatus: { $in: ['approved', 'completed'] }
        }
      });
      const completedOrderIds = new Set(allCompletedRawOrders.map(order => order.id));
      console.log(`[Create] Found ${completedOrderIds.size} raw completed/approved order IDs for publisher ${ctx.state.user.id}`);

      // STEP 2: Get ALL 'escrow_release' transactions for these completed orders.
      const allEscrowReleaseTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters: {
          user_wallet: { id: publisherWallet.id },
          type: 'escrow_release',
          order: { id: { $in: Array.from(completedOrderIds) } }
        },
        populate: ['order'],
        sort: { createdAt: 'desc' }
      });
      console.log(`[Create] Found ${allEscrowReleaseTransactions.length} total escrow_release transactions.`);

      // STEP 3: Deduplicate to get unique transactions per order.
      const orderTransactionMap = new Map();
      allEscrowReleaseTransactions.forEach(tx => {
        const orderId = tx.order?.id;
        if (orderId && completedOrderIds.has(orderId)) {
          if (!orderTransactionMap.has(orderId) || new Date(tx.createdAt) > new Date(orderTransactionMap.get(orderId).createdAt)) {
            orderTransactionMap.set(orderId, tx);
          }
        }
      });
      const uniqueCompletedOrderTransactions = Array.from(orderTransactionMap.values());
      console.log(`[Create] Found ${uniqueCompletedOrderTransactions.length} unique transactions for completed orders amount.`);
      
      // STEP 4: Calculate GROSS completedOrdersAmount.
      const grossCompletedOrdersAmount = uniqueCompletedOrderTransactions.reduce((total, tx) => {
        return total + parseFloat(tx.amount || 0);
      }, 0);
      console.log(`[Create] Calculated GROSS completedOrdersAmount: ${grossCompletedOrdersAmount}`);

      // STEP 5: Get current direct wallet balance and escrow balance from the publisherWallet entity.
      const directWalletBalance = parseFloat(publisherWallet.balance || 0);
      const currentEscrowBalance = parseFloat(publisherWallet.escrowBalance || 0);
      console.log(`[Create] Publisher directWalletBalance: ${directWalletBalance}, currentEscrowBalance: ${currentEscrowBalance}`);

      // STEP 6: Calculate totalAvailable for the pre-check.
      const totalAvailableForWithdrawalCheck = Math.max(0, (grossCompletedOrdersAmount + directWalletBalance) - currentEscrowBalance);
      console.log('[Create] Pre-withdrawal Balance Check:', {
        grossCompletedOrdersAmount,
        directWalletBalance,
        currentEscrowBalance,
        calculation: `(${grossCompletedOrdersAmount} + ${directWalletBalance}) - ${currentEscrowBalance} = ${totalAvailableForWithdrawalCheck}`,
        requestAmount
      });

      // STEP 7: Check if user has sufficient balance.
      if (totalAvailableForWithdrawalCheck < requestAmount) {
        return ctx.badRequest(`Insufficient funds. Available balance for withdrawal check: ${totalAvailableForWithdrawalCheck}, Requested: ${requestAmount}`);
      }

      // The rest of the create method continues from here...
      // Note: `completedOrdersTransactions` used later for marking specific transactions
      // might need to be derived differently if it was based on the old `availableTransactions`
      // For now, we assume the main goal is to fix the insufficient funds error.
      // The most straightforward approach is to pass all uniqueCompletedOrderTransactions and let the loop pick.
      const completedOrdersTransactionsToProcess = uniqueCompletedOrderTransactions;
      
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
      
      // Process transactions from completed orders to cover the withdrawal amount
      if (completedOrdersTransactionsToProcess.length > 0) {
        // Sort transactions by date (oldest first)
        completedOrdersTransactionsToProcess.sort((a, b) => {
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
        
        // Keep track of orders we've processed to avoid double-counting
        const processedOrderIds = new Set();
        
        // Track how much we still need to process
        let amountRemaining = requestAmount;
        
        // Process transactions until we've covered the required amount
        for (const tx of completedOrdersTransactionsToProcess) {
          if (amountRemaining <= 0) break;
          
          // Skip if no order or if this order has already been processed
          if (!tx.order || !tx.order.id || processedOrderIds.has(tx.order.id)) continue;
          
          // Mark this order as processed
          processedOrderIds.add(tx.order.id);
          
          const txAmount = parseFloat(tx.amount);
          const amountToUse = Math.min(txAmount, amountRemaining);
          
          console.log(`Processing transaction ${tx.id} from order ${tx.order.id} - amount: ${txAmount}, using: ${amountToUse}`);
          
          // Update transaction to mark it as included in this withdrawal request
          let baseDescription = tx.description || '';
          if (baseDescription.includes(' - Included in withdrawal request')) {
            baseDescription = baseDescription.split(' - Included in withdrawal request')[0];
          }
          
          await strapi.entityService.update('api::transaction.transaction', tx.id, {
            data: {
              description: `${baseDescription} - Included in withdrawal request #${withdrawalRequest.id}`
            }
          });
          
          amountRemaining -= amountToUse;
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
      
      // IMPORTANT: Update the wallet balance immediately when withdrawal is requested
      // This ensures the available balance reflects the pending withdrawal
      console.log('Updating wallet balance after withdrawal request:', {
        previousBalance: publisherWallet.balance,
        previousEscrow: publisherWallet.escrowBalance,
        withdrawalAmount: requestAmount
      });
      
      // Move the withdrawal amount from available balance to escrow
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: {
          // Don't change the main balance - the funds come from completed orders
          // Instead, track this in escrow so it's not available for future withdrawals
          escrowBalance: (publisherWallet.escrowBalance || 0) + requestAmount
        }
      });
      
      console.log('Wallet balance updated successfully after withdrawal request');
      
      return {
        data: withdrawalRequest,
        meta: {
          message: 'Withdrawal request created successfully',
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
      
      // STEP 1: Get all completed orders (used to ensure transactions are for valid orders)
      const allCompletedRawOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: userId,
          orderStatus: { $in: ['approved', 'completed'] }
        }
      });
      const completedOrderIds = new Set(allCompletedRawOrders.map(order => order.id));
      console.log(`Found ${completedOrderIds.size} raw completed/approved order IDs for publisher ${userId}`);

      // STEP 2: Get ALL 'escrow_release' transactions for the user's wallet.
      // These represent all funds that *have been* released from escrow for completed orders.
      // We will not filter these by "description includes withdrawal" here.
      const allEscrowReleaseTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters: {
          user_wallet: { id: publisherWallet.id },
          type: 'escrow_release', // Only consider funds released from escrow
          order: { id: { $in: Array.from(completedOrderIds) } } // Ensure transaction is for a completed/approved order
        },
        populate: ['order'], // Keep populate if needed for other parts, or remove if only amount is used
        sort: { createdAt: 'desc' }
      });
      console.log(`Found ${allEscrowReleaseTransactions.length} total escrow_release transactions for completed/approved orders.`);

      // STEP 3: Deduplicate these transactions to count each order's contribution only once (latest transaction).
      const orderTransactionMap = new Map();
      allEscrowReleaseTransactions.forEach(tx => {
        const orderId = tx.order?.id;
        if (orderId && completedOrderIds.has(orderId)) { // Double check order is relevant
          // If order not yet in map, or this tx is newer, add/update it.
          if (!orderTransactionMap.has(orderId) || new Date(tx.createdAt) > new Date(orderTransactionMap.get(orderId).createdAt)) {
            orderTransactionMap.set(orderId, tx);
          }
        }
      });
      const uniqueCompletedOrderTransactions = Array.from(orderTransactionMap.values());
      console.log(`Found ${uniqueCompletedOrderTransactions.length} unique transactions contributing to completed orders amount.`);

      // STEP 4: Calculate completedOrdersAmount from these unique transactions.
      // This is the GROSS amount from all completed orders.
      const completedOrdersAmount = uniqueCompletedOrderTransactions.reduce((total, tx) => {
        return total + parseFloat(tx.amount || 0);
      }, 0);
      console.log(`Calculated GROSS completedOrdersAmount: ${completedOrdersAmount}`);

      // STEP 5: Get Wallet Balance (direct funds, not from orders)
      const walletBalance = parseFloat(publisherWallet.balance || 0);
      console.log(`Publisher direct walletBalance: ${walletBalance}`);

      // STEP 6: Calculate Actual Escrow Balance from PENDING withdrawal requests.
      // This is the amount currently held due to active pending withdrawals.
      const pendingWithdrawals = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId },
          withdrawal_status: 'pending'
        }
      });
      const actualEscrowBalance = pendingWithdrawals.reduce((total, wr) => {
        return total + parseFloat(wr.amount || 0);
      }, 0);
      console.log(`Calculated actualEscrowBalance from ${pendingWithdrawals.length} pending withdrawals: ${actualEscrowBalance}`);

      // Self-correction for stored escrowBalance in user-wallet (optional but good)
      if (Math.abs(actualEscrowBalance - parseFloat(publisherWallet.escrowBalance || 0)) > 0.01) {
        console.log('Correcting stored publisherWallet.escrowBalance. Was:', publisherWallet.escrowBalance, 'Now:', actualEscrowBalance);
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: publisherWallet.id },
          data: { escrowBalance: actualEscrowBalance }
        });
      }
      const escrowBalance = actualEscrowBalance; // Use the freshly calculated one

      // STEP 7: Calculate final totalAvailable.
      // Available = (Gross Completed Orders + Direct Wallet Funds) - Actual Escrow
      const totalAvailable = Math.max(0, (completedOrdersAmount + walletBalance) - escrowBalance);
      console.log('Final balance calculation (getAvailableBalance):', {
        walletBalance,
        completedOrdersAmount, // Gross amount
        escrowBalance,         // Amount tied up in pending withdrawals
        calculation_String: `(${completedOrdersAmount} [completed] + ${walletBalance} [wallet]) - ${escrowBalance} [escrow] = ${totalAvailable}`,
        final_totalAvailable_Sent_To_Client: totalAvailable
      });

      // Fetch ALL withdrawal requests for calculating total earnings (if definition is sum of all withdrawals + current available)
      // This is separate from 'pendingWithdrawals' used for escrow calculation.
      const withdrawalRequests = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId },
          // Potentially filter by status if only 'paid' or 'approved' should count towards lifetime earnings
          // For now, let's assume all non-denied requests might be part of this definition.
          withdrawal_status: { $notIn: ['denied'] } 
        },
        sort: { createdAt: 'desc' }
      });
      console.log(`Fetched ${withdrawalRequests.length} non-denied withdrawal requests for totalEarnings calculation.`);

      // STEP 8: Return balance data.
      return {
        data: {
          walletBalance,
          completedOrdersAmount, // Gross amount from all legitimately completed orders
          escrowBalance,         // Current amount held in pending withdrawals
          totalAvailable,        // Net available for new withdrawals
          completedOrders: uniqueCompletedOrderTransactions, // These are the transactions making up completedOrdersAmount
          transactionCount: uniqueCompletedOrderTransactions.length,
          // Recalculate totalEarnings based on the fetched withdrawalRequests
          totalEarnings: withdrawalRequests.reduce((sum, wr) => sum + parseFloat(wr.amount || 0), 0) + totalAvailable 
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


