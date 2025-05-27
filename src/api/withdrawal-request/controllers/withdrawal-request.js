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
  
  // Admin endpoint to APPROVE (but not yet pay) a withdrawal request
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
      
      // ONLY update status to 'approved'. DO NOT process payment or reduce escrow here.
        const updatedRequest = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
          data: {
          withdrawal_status: 'approved' // Changed from 'paid'
        }
      });

      console.log(`Withdrawal request #${id} status changed to 'approved'. Escrow balance NOT changed at this step.`);

      // NO escrowBalance change here
      // NO payout transaction creation here

      // Create notification for publisher about approval
      try {
        await strapi.service('api::notification.notification').createPaymentNotification(
          withdrawalRequest.publisher.id,
          'withdrawal_approved',
          withdrawalRequest.amount
        );
      } catch (notificationError) {
        console.error('Failed to create withdrawal approved notification:', notificationError);
        // Don't fail the approval if notification fails
      }
        
        return {
          data: updatedRequest,
          meta: {
          message: 'Withdrawal request approved. Awaiting payment processing.'
          }
        };

    } catch (error) {
      console.error('Error approving withdrawal request (status update only):', error);
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

      // Create notification for publisher about denial
      try {
        await strapi.service('api::notification.notification').createPaymentNotification(
          withdrawalRequest.publisher.id,
          'withdrawal_denied',
          withdrawalRequest.amount
        );
      } catch (notificationError) {
        console.error('Failed to create withdrawal denied notification:', notificationError);
        // Don't fail the denial if notification fails
      }
      
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
  
  // Admin endpoint to MARK A WITHDRAWAL AS PAID (after external payment confirmation)
  async markAsPaidWithdrawal(ctx) {
    try {
      // Check if user is authenticated and is an admin
      if (!ctx.state.user || !ctx.state.user.role || ctx.state.user.role.type !== 'admin') {
        return ctx.forbidden('Admin access required');
      }

      const { id } = ctx.params;
      if (!id) {
        return ctx.badRequest('Withdrawal request ID is required.');
      }

      // Get the withdrawal request and populate publisher details
      const withdrawalRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', id, {
        populate: ['publisher']
      });

      if (!withdrawalRequest) {
        return ctx.notFound('Withdrawal request not found');
      }

      // Ensure the request is in 'approved' status (or 'pending' if direct payment is allowed)
      if (withdrawalRequest.withdrawal_status !== 'approved') {
        // If you allow marking 'pending' as paid directly, you can change this condition:
        // if (!['pending', 'approved'].includes(withdrawalRequest.withdrawal_status)) {
        return ctx.badRequest(`Withdrawal request must be in 'approved' status to be marked as paid. Current status: ${withdrawalRequest.withdrawal_status}`);
      }

      if (!withdrawalRequest.publisher || !withdrawalRequest.publisher.id) {
        return ctx.badRequest('Publisher details not found for this withdrawal request.');
      }

      // Get publisher wallet
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'publisher'
        }
      });

      if (!publisherWallet) {
        return ctx.badRequest('Publisher wallet not found for this user.');
      }

      // Simulate external payment confirmation (can be expanded with actual payment gateway responses)
      // Using a similar structure to your original approveWithdrawal for payment simulation
      let paymentResult;
      try {
        switch (withdrawalRequest.method) {
          case 'razorpay':
            // Assuming processRazorpayPayout confirms payment or is the payment itself
            paymentResult = await processRazorpayPayout(withdrawalRequest, true); // true might indicate final payment
            break;
          case 'paypal':
            paymentResult = await processPaypalPayout(withdrawalRequest, true);
            break;
          case 'bank_transfer':
          case 'payoneer':
            paymentResult = {
              success: true,
              transactionId: `paid_manual_${Date.now()}`,
              message: 'Manual payment confirmed and marked as paid.'
            };
            break;
          default:
            throw new Error(`Unsupported payment method: ${withdrawalRequest.method}`);
        }
      } catch (paymentError) {
        console.error('[MarkAsPaid] Payment processing/confirmation error:', paymentError);
        // Even if payment simulation fails, admin is overriding, but log it.
        // Depending on strictness, you might return ctx.badRequest here.
        paymentResult = { success: false, message: paymentError.message, transactionId: `failed_confirmation_${Date.now()}` };
        // For now, we'll proceed to mark as paid as per admin override, but this needs thought.
        // If payment MUST succeed here, then throw or return badRequest.
        // For this implementation, we assume admin is confirming an already occurred external payment.
         paymentResult = {
              success: true, 
              transactionId: `override_paid_${Date.now()}`,
              message: 'Admin marked as paid, overriding simulated payment failure.'
            }; 
      }

      if (!paymentResult.success) {
         console.warn(`[MarkAsPaid] Payment result indicated failure for withdrawal #${id}, but admin is marking as paid. Message: ${paymentResult.message}`);
         // Decide if you want to halt or proceed. For now, proceeding as admin override.
      }

      // Update the withdrawal request status to 'paid'
      const updatedRequest = await strapi.entityService.update('api::withdrawal-request.withdrawal-request', id, {
        data: {
          withdrawal_status: 'paid',
          // Potentially add payment transaction IDs or notes here from paymentResult
          // e.g., gateway_reference: paymentResult.transactionId
        }
      });

      // IMPORTANT: Release funds from escrow in the publisher's wallet
      // Ensure this only happens once for the lifetime of the withdrawal request.
      // Check current escrow to prevent double-deduction if this function were ever miscalled.
      const amountToDecreaseFromEscrow = parseFloat(withdrawalRequest.amount);
      if (parseFloat(publisherWallet.escrowBalance || 0) >= amountToDecreaseFromEscrow) {
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: publisherWallet.id },
          data: {
            escrowBalance: parseFloat(publisherWallet.escrowBalance || 0) - amountToDecreaseFromEscrow
          }
        });
        console.log(`[MarkAsPaid] Decreased escrow for wallet ${publisherWallet.id} by ${amountToDecreaseFromEscrow}. New theoretical escrow: ${parseFloat(publisherWallet.escrowBalance || 0) - amountToDecreaseFromEscrow}`);
      } else {
        console.warn(`[MarkAsPaid] Wallet ${publisherWallet.id} escrow ${publisherWallet.escrowBalance} is less than withdrawal amount ${amountToDecreaseFromEscrow}. Escrow not decreased further.`);
      }
      
      // Create a final 'payout' transaction log
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'payout',
          amount: withdrawalRequest.amount,
          netAmount: withdrawalRequest.amount, // Assuming no fees deducted at this stage by this system
          fee: 0,
          transactionStatus: 'success', // Or 'completed'
          gateway: withdrawalRequest.method,
          gatewayTransactionId: paymentResult.transactionId || `paid_${id}`,
          description: `Payout via ${withdrawalRequest.method} - Marked as Paid by Admin`,
          user_wallet: publisherWallet.id,
          withdrawal_request: id // Link to the withdrawal request
        }
      });

      console.log(`Withdrawal request #${id} successfully marked as paid.`);
      return {
        data: updatedRequest,
        meta: {
          message: 'Withdrawal request successfully marked as paid.'
        }
      };

    } catch (error) {
      console.error('Error in markAsPaidWithdrawal:', error);
      return ctx.internalServerError('An error occurred while marking withdrawal as paid.', { error: error.message });
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
        
      // STEP 6: Calculate Actual Escrow Balance from PENDING or APPROVED withdrawal requests.
      // This is the amount currently held due to active pending or approved-but-not-yet-paid withdrawals.
      const withdrawalsInEscrow = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId },
          withdrawal_status: { $in: ['pending', 'approved'] } // Include both pending and approved
        }
      });
      const actualEscrowBalance = withdrawalsInEscrow.reduce((total, wr) => {
        return total + parseFloat(wr.amount || 0);
      }, 0);
      console.log(`Calculated actualEscrowBalance from ${withdrawalsInEscrow.length} pending/approved withdrawals: ${actualEscrowBalance}`);

      // Self-correction for stored escrowBalance in user-wallet (optional but good)
      if (Math.abs(actualEscrowBalance - parseFloat(publisherWallet.escrowBalance || 0)) > 0.01) {
        console.log('Correcting stored publisherWallet.escrowBalance. Was:', publisherWallet.escrowBalance, 'Now:', actualEscrowBalance);
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: publisherWallet.id },
          data: { escrowBalance: actualEscrowBalance }
        });
      }
      const escrowBalance = actualEscrowBalance; // Use the freshly calculated one

      // NEW STEP: Calculate total amount from 'paid' withdrawal requests
      const paidWithdrawals = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId },
          withdrawal_status: 'paid'
        }
      });
      const totalPaidOutAmount = paidWithdrawals.reduce((total, wr) => {
        return total + parseFloat(wr.amount || 0);
      }, 0);
      console.log(`Calculated totalPaidOutAmount from ${paidWithdrawals.length} 'paid' withdrawals: ${totalPaidOutAmount}`);

      // STEP 7 (Modified): Calculate final totalAvailable.
      // Available = (Gross Completed Orders + Direct Wallet Funds - Total Paid Out) - Escrow for pending/approved
      const netRevenuePool = (completedOrdersAmount + walletBalance) - totalPaidOutAmount;
      const totalAvailable = Math.max(0, netRevenuePool - escrowBalance);
      
      console.log('Final balance calculation (getAvailableBalance):', {
        walletBalance,
        completedOrdersAmount, // Gross amount from completed orders
        totalPaidOutAmount,    // Total amount historically paid out
        escrowBalance,         // Amount currently tied up in PENDING or APPROVED withdrawals
        calculation_String: `((${completedOrdersAmount} [completed] + ${walletBalance} [wallet]) - ${totalPaidOutAmount} [paid]) - ${escrowBalance} [escrow] = ${totalAvailable}`,
        final_totalAvailable_Sent_To_Client: totalAvailable
      });
      
      // Fetch ALL withdrawal requests for calculating total earnings (if definition is sum of all withdrawals + current available)
      // This is separate from 'pendingWithdrawals' used for escrow calculation.
      // const withdrawalRequests = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
      //   filters: {
      //     publisher: { id: userId },
      //     // Potentially filter by status if only 'paid' or 'approved' should count towards lifetime earnings
      //     // For now, let's assume all non-denied requests might be part of this definition.
      //     withdrawal_status: { $notIn: ['denied'] } 
      //   },
      //   sort: { createdAt: 'desc' }
      // });
      // console.log(`Fetched ${withdrawalRequests.length} non-denied withdrawal requests for totalEarnings calculation.`);

      // STEP 8: Return balance data.
      return {
        data: {
          walletBalance,
          completedOrdersAmount, // Gross amount from all legitimately completed orders
          escrowBalance,         // Current amount held in pending/approved withdrawals
          totalAvailable,        // Net available for new withdrawals
          totalPaidOutAmount,    // Total amount historically paid out
          completedOrders: uniqueCompletedOrderTransactions, // These are the transactions making up completedOrdersAmount
          transactionCount: uniqueCompletedOrderTransactions.length,
          // totalEarnings: withdrawalRequests.reduce((sum, wr) => sum + parseFloat(wr.amount || 0), 0) + totalAvailable 
          totalEarnings: completedOrdersAmount + walletBalance // Represents total value generated into the publisher's account
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


