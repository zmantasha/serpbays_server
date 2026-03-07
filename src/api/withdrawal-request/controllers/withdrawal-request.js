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

      // 🛡️ ENHANCED DUPLICATE PREVENTION: Check with shorter window and add request ID uniqueness
      const tenSecondsAgo = new Date(Date.now() - 10 * 1000);// Reduced from 10 sec
      const recentDuplicate = await strapi.db.query('api::withdrawal-request.withdrawal-request').findOne({
        where: {
          publisher: ctx.state.user.id,
          amount: requestAmount,
          method: method,
          createdAt: {
            $gte: tenSecondsAgo
          }
        }
      });

      if (recentDuplicate) {
        console.log(`[DUPLICATE PREVENTION] Blocking duplicate withdrawal request for user ${ctx.state.user.id}:`, {
          existingRequest: recentDuplicate.id,
          amount: requestAmount,
          method: method
        });
        return ctx.badRequest('Duplicate withdrawal request detected. Please wait before making another request with the same amount and method.');
      }

      // 🔒 ADD REQUEST UNIQUENESS: Create unique gateway transaction ID early
      const uniqueRequestId = `${ctx.state.user.id}_${requestAmount}_${method}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      console.log(`[DUPLICATE PREVENTION] Generated unique request ID: ${uniqueRequestId}`);
      
      // Get publisher wallet
      const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { 
          users_permissions_user: ctx.state.user.id
        }
      });
      
      if (!publisherWallet) {
        console.log('Publisher wallet not found for user:', ctx.state.user.id);
        return ctx.badRequest('Publisher wallet not found');
      }
      console.log('Found publisher wallet:', { 
        id: publisherWallet.id, 
        balance: publisherWallet.balance, 
        escrow: publisherWallet.escrowBalance,
        pendingWithdrawalBalance: publisherWallet.pendingWithdrawalBalance,
        fullWalletObject: publisherWallet
      });
      
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
        
      // STEP 5: Check available balance (Available Balance = Wallet Balance)
      const walletBalance = parseFloat(publisherWallet.balance || 0);
      const pendingWithdrawalBalance = parseFloat(publisherWallet.pendingWithdrawalBalance || 0);
      
      console.log('[Create] Pre-withdrawal Balance Check:', {
        walletBalance,
        pendingWithdrawalBalance,
        requestAmount,
        note: 'Available balance equals wallet balance'
        });
        
      // STEP 6: Check if user has sufficient MAIN balance for withdrawal (promo funds cannot be withdrawn)
      const mainBalance = parseFloat(publisherWallet.mainBalance || 0);
      const promoBalance = parseFloat(publisherWallet.promoBalance || 0);
      const totalBalance = parseFloat(publisherWallet.balance || 0);
      
      console.log('Balance breakdown:', {
        mainBalance,
        promoBalance,
        totalBalance,
        requestAmount
      });
      
      // Calculate 20% platform fee
      const PLATFORM_FEE_RATE = 0.20;
      const platformFee = Math.round((requestAmount / (1 - PLATFORM_FEE_RATE)) * PLATFORM_FEE_RATE * 100) / 100;
      const totalDeduction = Math.round((requestAmount + platformFee) * 100) / 100;

      console.log('Platform fee calculation:', {
        requestAmount,
        platformFeeRate: PLATFORM_FEE_RATE,
        platformFee,
        totalDeduction
      });

      if (mainBalance < totalDeduction) {
        return ctx.badRequest(`Insufficient withdrawable funds. Available for withdrawal: ${mainBalance}, Total required (including 20% platform fee): ${totalDeduction}. Note: Promo credits (${promoBalance}) cannot be withdrawn.`);
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
      
      // Create a transaction record for the withdrawal request with unique ID
      const transactionRecord = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'withdrawal',
          amount: totalDeduction,
          netAmount: requestAmount,
          fee: platformFee,
          transactionStatus: 'pending',
          gateway: method,
          gatewayTransactionId: uniqueRequestId, // 🔒 Use unique ID to prevent duplicates
          description: `Withdrawal request #${withdrawalRequest.id} via ${method} — $${requestAmount} payout + $${platformFee} platform fee (20%)`,
          user_wallet: publisherWallet.id,
          users_permissions_user: ctx.state.user.id
        }
      });
      
      console.log(`[DUPLICATE PREVENTION] Created unique transaction ${transactionRecord.id} with gateway ID: ${uniqueRequestId}`);
      
      // Update the wallet balance when withdrawal is requested
      // Deduct totalDeduction (withdrawal amount + 20% platform fee) from main balance
      console.log('Updating wallet balance after withdrawal request:', {
        previousBalance: publisherWallet.balance,
        previousMainBalance: publisherWallet.mainBalance,
        withdrawalAmount: requestAmount,
        platformFee,
        totalDeduction
      });

      // Subtract the TOTAL (withdrawal + fee) from MAIN balance, track only requestAmount as pending withdrawal
      const newMainBalance = (parseFloat(publisherWallet.mainBalance) || 0) - totalDeduction;
      const newTotalBalance = newMainBalance + (parseFloat(publisherWallet.promoBalance) || 0);

      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: {
          mainBalance: newMainBalance,
          balance: newTotalBalance,
          pendingWithdrawalBalance: (parseFloat(publisherWallet.pendingWithdrawalBalance) || 0) + requestAmount
        }
      });

      console.log(`Subtracted $${totalDeduction} from wallet (payout: $${requestAmount} + fee: $${platformFee}). New main balance: ${newMainBalance}`);
      
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
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;
      const { pagination, filters: queryFilters } = ctx.query;

      console.log('[WithdrawalController|getMyWithdrawals] Received query:', JSON.stringify(ctx.query, null, 2));

      // Base filters: always filter by the current user
      const baseFilters = {
        publisher: { id: userId },
      };

      // Merge base filters with filters from query string
      let combinedFilters = { ...baseFilters };
      if (queryFilters && typeof queryFilters === 'object') {
        // Example: if queryFilters is { withdrawal_status: { '$eq': 'paid' } }
        // it will be merged directly.
        // Strapi's entityService expects filters in a nested structure.
        // The frontend sends: filters[withdrawal_status][$eq]=paid
        // Strapi's qs parser turns this into: { withdrawal_status: { '$eq': 'paid' } }
        // So, we can merge queryFilters directly.
        for (const key in queryFilters) {
          if (Object.prototype.hasOwnProperty.call(queryFilters, key)) {
            combinedFilters[key] = queryFilters[key];
          }
        }
      }
      
      console.log('[WithdrawalController|getMyWithdrawals] Combined filters for query:', JSON.stringify(combinedFilters, null, 2));

      // Default pagination if not provided
      const start = parseInt(pagination?.start || '0', 10);
      const limit = parseInt(pagination?.limit || '10', 10); // Default to 10 if not specified

      console.log('[WithdrawalController|getMyWithdrawals] Pagination params:', { start, limit });

      const withdrawalRequests = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: combinedFilters,
        sort: { createdAt: 'desc' },
        start: start, // for offset
        limit: limit, // for page size
      });
      
      // For accurate hasMoreItems, we might need to query total count with filters but without pagination
      // Or, rely on the frontend logic: if count returned is less than limit, no more items.
      // The current frontend logic (historyData.length === WITHDRAWALS_PER_PAGE) works if the API returns a full page or less.

      const totalCount = await strapi.entityService.count('api::withdrawal-request.withdrawal-request', {
        filters: combinedFilters,
      });


      console.log(`[WithdrawalController|getMyWithdrawals] Retrieved ${withdrawalRequests.length} requests for user ${userId} with filters. Total matching: ${totalCount}`);
      
      // Strapi's findMany typically returns just the array of entities if no 'meta' is requested via populate.
      // The frontend expects { data: [...] }
      // Let's ensure the response structure matches what the frontend service expects (data.data)
      return {
        data: withdrawalRequests, // The array of entities
        meta: { // Optional: Strapi like meta for pagination
          pagination: {
            start,
            limit,
            total: totalCount,
            page: Math.floor(start / limit) + 1,
            pageCount: Math.ceil(totalCount / limit),
          }
        }
      };
    } catch (error) {
      console.error('Error fetching withdrawal requests:', error);
      // Log the actual error for better debugging
      console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
      return ctx.internalServerError('An error occurred while fetching withdrawal requests', { error: error.message });
    }
  },
  
  // Admin endpoint to APPROVE (but not yet pay) a withdrawal request
  async approveWithdrawal(ctx) {
    try {
      // Check if user is authenticated and is an admin
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      // Check if user is an admin or has special access
      const { role, email } = ctx.state.user;
      const hasAdminAccess = (role && role.type === 'admin') || email === 'mantasha@wordscloud.in';
      
      if (!hasAdminAccess) {
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
          users_permissions_user: withdrawalRequest.publisher.id
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
        console.log(`[WithdrawalController] About to create withdrawal_approved notification`);
        console.log(`[WithdrawalController] Publisher ID: ${withdrawalRequest.publisher.id}, Amount: ${withdrawalRequest.amount}`);
        
        await strapi.service('api::notification.notification').createPaymentNotification(
          withdrawalRequest.publisher.id,
          'withdrawal_approved',
          withdrawalRequest.amount
        );
        
        console.log(`[WithdrawalController] Withdrawal approved notification created successfully`);
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
      
      // Check if user is an admin or has special access
      const { role, email } = ctx.state.user;
      const hasAdminAccess = (role && role.type === 'admin') || email === 'mantasha@wordscloud.in';
      
      if (!hasAdminAccess) {
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
          users_permissions_user: withdrawalRequest.publisher.id
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
      
      // 🔧 Update the corresponding withdrawal request transaction to 'failed' since withdrawal was denied
      console.log(`[DenyWithdrawal] Updating withdrawal request transaction for withdrawal #${id}`);
      
      const escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'withdrawal',
          transactionStatus: 'pending',
          description: { $contains: 'Withdrawal request' }
        }
      });
      
      if (escrowHoldTransaction) {
        await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
          data: {
            transactionStatus: 'denied',
            description: `${escrowHoldTransaction.description} - Withdrawal denied: ${reason || 'No reason provided'}`
          }
        });
        console.log(`[DenyWithdrawal] Updated withdrawal request transaction ${escrowHoldTransaction.id} to failed`);
      } else {
        console.log(`[DenyWithdrawal] No matching withdrawal request transaction found for withdrawal #${id}`);
      }
      
      // Return the funds to the publisher's MAIN balance (since withdrawals only come from main balance)
      const refundAmount = parseFloat(withdrawalRequest.amount);
      const newMainBalance = (parseFloat(publisherWallet.mainBalance) || 0) + refundAmount;
      const newTotalBalance = newMainBalance + (parseFloat(publisherWallet.promoBalance) || 0);
      
      await strapi.db.query('api::user-wallet.user-wallet').update({
        where: { id: publisherWallet.id },
        data: {
          mainBalance: newMainBalance,
          balance: newTotalBalance,
          pendingWithdrawalBalance: Math.max(0, (parseFloat(publisherWallet.pendingWithdrawalBalance) || 0) - refundAmount)
        }
      });
      
      // Create a transaction record for the refund
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'refund',
          amount: withdrawalRequest.amount,
          netAmount: withdrawalRequest.amount,
          fee: 0,
          transactionStatus: 'denied',
          gateway: 'internal',
          description: `Withdrawal request denied: ${reason || 'No reason provided'}`,
          user_wallet: publisherWallet.id
        }
      });

      // Create notification for publisher about denial
      try {
        console.log(`[WithdrawalController] About to create withdrawal_denied notification`);
        console.log(`[WithdrawalController] Publisher ID: ${withdrawalRequest.publisher.id}, Amount: ${withdrawalRequest.amount}`);
        
        await strapi.service('api::notification.notification').createPaymentNotification(
          withdrawalRequest.publisher.id,
          'withdrawal_denied',
          withdrawalRequest.amount
        );
        
        console.log(`[WithdrawalController] Withdrawal denied notification created successfully`);
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
      // Check if user is authenticated and has admin access
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const { role, email } = ctx.state.user;
      const hasAdminAccess = (role && role.type === 'admin') || email === 'mantasha@wordscloud.in';
      
      if (!hasAdminAccess) {
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
          users_permissions_user: withdrawalRequest.publisher.id
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

      // 🔧 Update the corresponding withdrawal request transaction to 'success' since withdrawal is now paid
      console.log(`[MarkAsPaid] Updating withdrawal request transaction for withdrawal #${id}`);
      
      const escrowHoldTransaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: {
          users_permissions_user: withdrawalRequest.publisher.id,
          type: 'withdrawal',
          transactionStatus: 'pending',
          description: { $contains: 'Withdrawal request' }
        }
      });
      
      if (escrowHoldTransaction) {
        await strapi.entityService.update('api::transaction.transaction', escrowHoldTransaction.id, {
          data: {
            transactionStatus: 'paid',
            description: `${escrowHoldTransaction.description} - Payment completed`
          }
        });
        console.log(`[MarkAsPaid] Updated withdrawal request transaction ${escrowHoldTransaction.id} to success`);
      } else {
        console.log(`[MarkAsPaid] No matching withdrawal request transaction found for withdrawal #${id}`);
      }

      // IMPORTANT: Release funds from pending withdrawal balance in the publisher's wallet
      // Ensure this only happens once for the lifetime of the withdrawal request.
      // Check current pending balance to prevent double-deduction if this function were ever miscalled.
      const amountToDecreaseFromPending = parseFloat(withdrawalRequest.amount);
      if (parseFloat(publisherWallet.pendingWithdrawalBalance || 0) >= amountToDecreaseFromPending) {
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: publisherWallet.id },
          data: {
            pendingWithdrawalBalance: Math.max(0, parseFloat(publisherWallet.pendingWithdrawalBalance || 0) - amountToDecreaseFromPending)
          }
        });
        console.log(`[MarkAsPaid] Decreased pendingWithdrawalBalance for wallet ${publisherWallet.id} by ${amountToDecreaseFromPending}. New pending balance: ${Math.max(0, parseFloat(publisherWallet.pendingWithdrawalBalance || 0) - amountToDecreaseFromPending)}`);
      } else {
        console.warn(`[MarkAsPaid] Wallet ${publisherWallet.id} pendingWithdrawalBalance ${publisherWallet.pendingWithdrawalBalance} is less than withdrawal amount ${amountToDecreaseFromPending}. Pending balance not decreased further.`);
      }
      
      // Create a final 'payout' transaction log
      await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'payout',
          amount: withdrawalRequest.amount,
          netAmount: withdrawalRequest.amount, // Assuming no fees deducted at this stage by this system
          fee: 0,
          transactionStatus: 'paid', // Or 'completed'
          gateway: withdrawalRequest.method,
          gatewayTransactionId: paymentResult.transactionId || `paid_${id}`,
          description: `Payout via ${withdrawalRequest.method} - Marked as Paid by Admin`,
          user_wallet: publisherWallet.id,
          withdrawal_request: id // Link to the withdrawal request
        }
      });

      console.log(`Withdrawal request #${id} successfully marked as paid.`);
      
      // Create notification for publisher about payment completion
      try {
        console.log(`[WithdrawalController] About to create withdrawal_paid notification`);
        console.log(`[WithdrawalController] Publisher ID: ${withdrawalRequest.publisher.id}, Amount: ${withdrawalRequest.amount}`);
        
        await strapi.service('api::notification.notification').createPaymentNotification(
          withdrawalRequest.publisher.id,
          'withdrawal_paid',
          withdrawalRequest.amount
        );
        
        console.log(`[WithdrawalController] Withdrawal paid notification created successfully`);
      } catch (notificationError) {
        console.error('Failed to create withdrawal paid notification:', notificationError);
        // Don't fail the payment marking if notification fails
      }
      
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
          users_permissions_user: { id: userId }
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
        
      // STEP 6: Get stored pending withdrawal balance from wallet
      // This is the amount currently held due to active pending withdrawals
      const pendingWithdrawalBalance = parseFloat(publisherWallet.pendingWithdrawalBalance || 0);
      console.log(`Using stored pendingWithdrawalBalance: ${pendingWithdrawalBalance}`);

      // Keep escrow balance for order processing (separate from withdrawal pending balance)
      const escrowBalance = parseFloat(publisherWallet.escrowBalance || 0);
      console.log(`Escrow balance (for orders): ${escrowBalance}`);

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
      // Available Balance = Wallet Balance - Pending Withdrawals (simple and direct)
      const totalAvailable = Math.max(0, walletBalance - pendingWithdrawalBalance);
      
      console.log('Final balance calculation (getAvailableBalance):', {
        walletBalance,
        completedOrdersAmount, // Gross amount from completed orders (for reference)
        totalPaidOutAmount,    // Total amount historically paid out (for reference)
        escrowBalance,         // Amount currently tied up for order processing
        pendingWithdrawalBalance, // Amount pending withdrawal
        calculation_String: `${walletBalance} [wallet] - ${pendingWithdrawalBalance} [pending] = ${totalAvailable}`,
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
          escrowBalance,         // Current amount held for order processing
          pendingWithdrawalBalance, // Current amount pending withdrawal
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
  },
  
  // Export all my withdrawals
  async exportAllMyWithdrawals(ctx) {
    try {
      // Check if user is authenticated
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;

      // Get all withdrawal requests for the user without pagination
      const withdrawalRequests = await strapi.entityService.findMany('api::withdrawal-request.withdrawal-request', {
        filters: {
          publisher: { id: userId }
        },
        sort: { createdAt: 'desc' },
        populate: ['publisher']
      });

      return {
        data: withdrawalRequests
      };
    } catch (error) {
      console.error('Error exporting withdrawal requests:', error);
      return ctx.internalServerError('Failed to export withdrawal requests', { error: error.message });
    }
  },

  // Debug endpoint to check transaction details for a user
  async debugTransactions(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }
      
      const userId = ctx.state.user.id;
      
      // Get publisher wallet
      const publisherWallets = await strapi.entityService.findMany('api::user-wallet.user-wallet', {
        filters: { 
          users_permissions_user: { id: userId },
          type: 'publisher'
        }
      });
      
      const publisherWallet = publisherWallets?.[0];
      
      if (!publisherWallet) {
        return { message: 'No publisher wallet found', userId };
      }
      
      // Get all completed orders
      const completedOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: userId,
          orderStatus: { $in: ['approved', 'completed'] }
        }
      });
      
      // Get all transactions for this wallet
      const allTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters: {
          user_wallet: { id: publisherWallet.id }
        },
        populate: ['order'],
        sort: { createdAt: 'desc' }
      });
      
      // Get escrow_release transactions specifically
      const escrowReleaseTransactions = await strapi.entityService.findMany('api::transaction.transaction', {
        filters: {
          user_wallet: { id: publisherWallet.id },
          type: 'escrow_release'
        },
        populate: ['order'],
        sort: { createdAt: 'desc' }
      });
      
      return {
        data: {
          userId,
          publisherWallet: {
            id: publisherWallet.id,
            balance: publisherWallet.balance,
            escrowBalance: publisherWallet.escrowBalance
          },
          completedOrders: completedOrders.map(o => ({
            id: o.id,
            status: o.orderStatus,
            amount: o.totalAmount,
            completedDate: o.completedDate
          })),
          allTransactionsCount: allTransactions.length,
          escrowReleaseTransactionsCount: escrowReleaseTransactions.length,
          escrowReleaseTransactions: escrowReleaseTransactions.map(t => ({
            id: t.id,
            type: t.type,
            amount: t.amount,
            orderId: t.order?.id,
            description: t.description,
            createdAt: t.createdAt,
            publishedAt: t.publishedAt
          }))
        }
      };
    } catch (error) {
      console.error('Debug transactions error:', error);
      return ctx.badRequest('Debug failed', { error: error.message });
    }
  },

  // Migration endpoint to create missing escrow_release transactions for completed orders
  async fixMissingTransactions(ctx) {
    try {
      if (!ctx.state.user) {
        return ctx.unauthorized('Authentication required');
      }

      const userId = ctx.state.user.id;

      // Get publisher wallet
      const publisherWallets = await strapi.entityService.findMany('api::user-wallet.user-wallet', {
        filters: { 
          users_permissions_user: { id: userId },
          type: 'publisher'
        }
      });
      
      const publisherWallet = publisherWallets?.[0];
      
      if (!publisherWallet) {
        return { message: 'No publisher wallet found', userId };
      }

      // Get all completed orders for this publisher
      const completedOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          publisher: userId,
          orderStatus: { $in: ['approved', 'completed'] }
        }
      });

      console.log(`Found ${completedOrders.length} completed orders for publisher ${userId}`);

      let createdTransactions = 0;
      let skippedTransactions = 0;

      for (const order of completedOrders) {
        // Check if escrow_release transaction already exists for this order
        const existingTransaction = await strapi.entityService.findMany('api::transaction.transaction', {
          filters: {
            user_wallet: { id: publisherWallet.id },
            type: 'escrow_release',
            order: { id: order.id }
          }
        });

        if (existingTransaction.length > 0) {
          console.log(`Transaction already exists for order ${order.id}, skipping`);
          skippedTransactions++;
          continue;
        }

        // Create missing escrow_release transaction
        const paymentTransaction = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'escrow_release',
            amount: order.totalAmount,
            netAmount: order.totalAmount,
            transactionStatus: 'success',
            gateway: 'migration',
            gatewayTransactionId: `migration_${order.id}_${Date.now()}`,
            description: `Payment for order #${order.id} - funds available for withdrawal (migrated)`,
            user_wallet: publisherWallet.id,
            users_permissions_user: userId,
            order: order.id,
            publishedAt: new Date()
          }
        });

        console.log(`Created missing transaction for order ${order.id}: transaction ID ${paymentTransaction.id}`);
        createdTransactions++;
      }

      return {
        data: {
          userId,
          publisherWalletId: publisherWallet.id,
          completedOrdersCount: completedOrders.length,
          createdTransactions,
          skippedTransactions,
          message: `Migration completed. Created ${createdTransactions} missing transactions, skipped ${skippedTransactions} existing ones.`
        }
      };
    } catch (error) {
      console.error('Fix missing transactions error:', error);
      return ctx.badRequest('Migration failed', { error: error.message });
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
  try {
    console.log('Processing PayPal payout for withdrawal:', withdrawalRequest.id);
    
    // Get the payment service
    const paymentService = strapi.service('api::transaction.payment');
    
    // Check if PayPal payouts are available
    try {
      // Create PayPal payout
      const payoutResult = await paymentService.createPayPalPayout(
        parseFloat(withdrawalRequest.amount),
        'USD', // You might want to make this dynamic
        withdrawalRequest.paymentDetails?.email || withdrawalRequest.publisher?.email,
        {
          withdrawalId: withdrawalRequest.id,
          userId: withdrawalRequest.publisher?.id
        }
      );
    
      if (payoutResult.success) {
        console.log('PayPal payout created successfully:', payoutResult.batchId);
        
        // Update withdrawal request with PayPal batch ID
        await strapi.entityService.update('api::withdrawal-request.withdrawal-request', withdrawalRequest.id, {
          data: {
            external_transaction_id: payoutResult.batchId,
            payment_reference: payoutResult.batchId,
            processedAt: new Date()
          }
        });
        
        return {
          success: true,
          transactionId: payoutResult.batchId,
          message: 'PayPal payout successfully created',
          batchId: payoutResult.batchId
        };
      } else {
        throw new Error('PayPal payout creation failed');
      }
    } catch (payoutError) {
      if (payoutError.message.includes('PayPal payouts SDK not available')) {
        console.warn('PayPal payouts SDK not available, falling back to manual processing');
        return {
          success: true,
          transactionId: `manual_paypal_${Date.now()}`,
          message: 'PayPal payout queued for manual processing (SDK not available)',
          requiresManualProcessing: true
        };
      }
      throw payoutError;
    }
  } catch (error) {
    console.error('PayPal payout error:', error);
    return {
      success: false,
      error: error.message,
      message: 'PayPal payout failed'
    };
  }
}
