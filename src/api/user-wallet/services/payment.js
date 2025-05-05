'use strict';

module.exports = {
  // Create a payment session with the specified gateway
  async createPayment(transaction, gateway) {
    try {
      // Ensure we have a transaction ID
      if (!transaction || !transaction.id) {
        console.error('Invalid transaction object:', transaction);
        throw new Error('Invalid transaction data');
      }

      console.log('createPayment called with transaction ID:', transaction.id, 'and gateway:', gateway);
      
      // Check gateway type and call appropriate handler
      switch (gateway) {
        case 'stripe':
          return this.createStripePayment(transaction);
        case 'paypal':
          return this.createPaypalPayment(transaction);
        case 'razorpay':
          return this.createRazorpayPayment(transaction);
        case 'test':
          return this.createSimpleTestPayment(transaction);
        default:
          throw new Error(`Unsupported payment gateway: ${gateway}`);
      }
    } catch (error) {
      console.error('Payment service error:', error);
      throw error;
    }
  },

  // Create a simplified test payment that doesn't rely on transaction lookups
  async createSimpleTestPayment(transaction) {
    try {
      console.log('Creating simple test payment for transaction:', transaction.id);
      
      // First, find the wallet directly if it's not populated
      let walletId = transaction.user_wallet;
      
      if (typeof walletId === 'object' && walletId !== null) {
        walletId = walletId.id;
      }
      
      if (!walletId) {
        console.error('No wallet ID in transaction:', transaction);
        throw new Error('No wallet ID provided');
      }
      
      console.log('Using wallet ID:', walletId);
      
      // Find the wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId }
      });
      
      if (!wallet) {
        console.error('Wallet not found for ID:', walletId);
        throw new Error('Wallet not found');
      }
      
      console.log('Found wallet:', wallet.id, 'with balance:', wallet.balance);
      
      // Update the transaction status using direct database method to avoid schema issues
      try {
        await strapi.db.query('api::transaction.transaction').update({
          where: { id: transaction.id },
          data: {
            transactionStatus: 'success',
            status: 'success',
            gatewayTransactionId: `test_${Date.now()}`
          }
        });
        
        console.log('Updated transaction status to success');
      } catch (updateError) {
        console.error('Error updating transaction status:', updateError);
        throw new Error('Failed to update transaction status');
      }
      
      // Get all successful transactions for this wallet to calculate the new balance
      const transactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: { 
          user_wallet: walletId,
          transactionStatus: 'success'
        }
      });
      
      // Calculate balance from all successful transactions
      let calculatedBalance = 0;
      for (const tx of transactions) {
        const amount = parseFloat(tx.amount) || 0;
        if (tx.type === 'deposit') {
          calculatedBalance += amount;
        } else if (tx.type === 'withdrawal') {
          calculatedBalance -= amount;
        }
      }
      
      console.log('Calculated balance from all transactions:', calculatedBalance);
      
      // Update wallet balance using direct database method to avoid schema issues
      try {
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: walletId },
          data: { 
            balance: calculatedBalance.toString()
          }
        });
        
        console.log('Updated wallet balance to:', calculatedBalance);
      } catch (updateBalanceError) {
        console.error('Error updating wallet balance:', updateBalanceError);
        throw new Error('Failed to update wallet balance');
      }
      
      // Return payment info
      return {
        provider: 'test',
        success: true,
        amount: transaction.amount,
        transactionId: `test_${Date.now()}`,
        message: 'Payment successful',
        // Include info to open a mock payment gateway
        paymentUrl: 'javascript:void(0)',
        showModal: true,
      };
    } catch (error) {
      console.error('Simple test payment error:', error);
      throw error;
    }
  },

  // Handle payment webhook callbacks
  async handleWebhook(gateway, payload) {
    switch (gateway) {
      case 'stripe':
        return this.handleStripeWebhook(payload);
      case 'paypal':
        return this.handlePaypalWebhook(payload);
      case 'razorpay':
        return this.handleRazorpayWebhook(payload);
      default:
        throw new Error(`Unsupported payment gateway: ${gateway}`);
    }
  },

  // Create a Stripe payment session
  async createStripePayment(transaction) {
    try {
      // You would need to install stripe package: npm install stripe
      // const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      
      // For now, we'll mock this for demonstration
      const paymentIntent = {
        id: `pi_${Math.random().toString(36).substr(2, 9)}`,
        amount: transaction.amount * 100, // Stripe uses cents
        currency: 'usd',
        client_secret: `seti_${Math.random().toString(36).substr(2, 9)}`,
      };

      // Update transaction with gateway ID
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: {
          gatewayTransactionId: paymentIntent.id,
        },
      });

      return {
        provider: 'stripe',
        clientSecret: paymentIntent.client_secret,
        amount: transaction.amount,
        transactionId: paymentIntent.id,
      };
    } catch (error) {
      console.error('Stripe payment error:', error);
      throw error;
    }
  },

  // Create a PayPal payment session
  async createPaypalPayment(transaction) {
    try {
      console.log('Creating PayPal payment for transaction:', transaction.id);
      
      // You would need to implement PayPal SDK integration
      // For now, we'll mock this for demonstration
      const paymentIntent = {
        id: `PP_${Math.random().toString(36).substr(2, 9)}`,
        amount: transaction.amount,
        currency: 'USD',
        // Use a real-looking PayPal URL format that will actually open
        approval_url: `https://www.sandbox.paypal.com/checkoutnow?token=EC-${Math.random().toString(36).substr(2, 12)}`,
      };

      console.log('Generated PayPal approval URL:', paymentIntent.approval_url);

      // Update transaction with gateway ID
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: {
          gatewayTransactionId: paymentIntent.id,
        },
      });

      return {
        provider: 'paypal',
        approvalUrl: paymentIntent.approval_url,
        amount: transaction.amount,
        transactionId: paymentIntent.id,
      };
    } catch (error) {
      console.error('PayPal payment error:', error);
      throw error;
    }
  },

  // Create a Razorpay payment session
  async createRazorpayPayment(transaction) {
    try {
      // You would need to install razorpay package: npm install razorpay
      // const Razorpay = require('razorpay');
      // const razorpay = new Razorpay({
      //   key_id: process.env.RAZORPAY_KEY_ID,
      //   key_secret: process.env.RAZORPAY_KEY_SECRET,
      // });
      
      // For now, we'll mock this for demonstration
      const order = {
        id: `order_${Math.random().toString(36).substr(2, 9)}`,
        amount: transaction.amount * 100, // Razorpay uses paise
        currency: 'INR',
        receipt: `rcpt_${transaction.id}`,
      };

      // Update transaction with gateway ID
      await strapi.entityService.update('api::transaction.transaction', transaction.id, {
        data: {
          gatewayTransactionId: order.id,
        },
      });

      return {
        provider: 'razorpay',
        orderId: order.id,
        amount: transaction.amount,
        currency: 'INR',
        keyId: 'rzp_test_xxxxxxxxxxxx', // Replace with your Razorpay key in production
      };
    } catch (error) {
      console.error('Razorpay payment error:', error);
      throw error;
    }
  },

  // Handle Stripe webhook
  async handleStripeWebhook(payload) {
    // Verify signature in production
    const event = payload;
    
    if (event.type === 'payment_intent.succeeded') {
      return this.updateTransactionStatus(event.data.object.id, 'success');
    } 
    else if (event.type === 'payment_intent.payment_failed') {
      return this.updateTransactionStatus(event.data.object.id, 'failed');
    }
    
    return { received: true };
  },

  // Handle PayPal webhook
  async handlePaypalWebhook(payload) {
    // Verify webhook in production
    const event = payload;
    
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      return this.updateTransactionStatus(event.resource.id, 'success');
    } 
    else if (event.event_type === 'PAYMENT.CAPTURE.DENIED') {
      return this.updateTransactionStatus(event.resource.id, 'failed');
    }
    
    return { received: true };
  },

  // Handle Razorpay webhook
  async handleRazorpayWebhook(payload) {
    // Verify webhook signature in production
    const event = payload;
    
    if (event.event === 'payment.captured') {
      return this.updateTransactionStatus(event.payload.payment.entity.order_id, 'success');
    } 
    else if (event.event === 'payment.failed') {
      return this.updateTransactionStatus(event.payload.payment.entity.order_id, 'failed');
    }
    
    return { received: true };
  },

  // Update transaction status and wallet balance if needed
  async updateTransactionStatus(gatewayTransactionId, status) {
    try {
      console.log(`Updating transaction status for ID ${gatewayTransactionId} to ${status}`);
      
      // Find the transaction
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId },
        populate: ['user_wallet'],
      });

      if (!transaction) {
        console.error(`Transaction not found with gateway ID: ${gatewayTransactionId}`);
        
        // Try finding by transaction ID directly (for test webhook)
        const directTransaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { id: gatewayTransactionId },
          populate: ['user_wallet'],
        });
        
        if (!directTransaction) {
          throw new Error(`Transaction not found with ID: ${gatewayTransactionId}`);
        }
        
        console.log(`Found transaction by direct ID: ${directTransaction.id}`);
        return this.updateTransactionById(directTransaction.id, status);
      }

      return this.updateTransactionById(transaction.id, status);
    } catch (error) {
      console.error('Error updating transaction:', error);
      throw error;
    }
  },
  
  // Helper method to update transaction by ID and handle wallet updates
  async updateTransactionById(transactionId, status) {
    try {
      console.log(`Updating transaction ${transactionId} to status ${status}`);
      
      // Get the full transaction with wallet
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { id: transactionId },
        populate: ['user_wallet'],
      });
      
      if (!transaction) {
        throw new Error(`Transaction not found with ID: ${transactionId}`);
      }
      
      console.log('Current transaction status:', transaction.transactionStatus || transaction.status);
      
      // Skip if status is already set (prevent duplicate updates)
      if (transaction.transactionStatus === status || transaction.status === status) {
        console.log(`Transaction ${transactionId} already has status ${status}`);
        return { success: true, transaction: transactionId, status, message: 'Status already set' };
      }
      
      // Update transaction status using database query
      await strapi.db.query('api::transaction.transaction').update({
        where: { id: transactionId },
        data: { 
          transactionStatus: status,
          status: status
        }
      });
      
      console.log(`Updated transaction ${transactionId} status to ${status}`);

      // If transaction is successful and is a deposit, update wallet balance
      if (status === 'success' && transaction.type === 'deposit') {
        // Extract wallet ID
        let walletId = transaction.user_wallet;
        if (typeof walletId === 'object' && walletId !== null) {
          walletId = walletId.id;
        }

        if (!walletId) {
          throw new Error('Wallet not found for transaction');
        }
        
        console.log(`Updating wallet ${walletId} balance for successful deposit`);
        
        // Get wallet
        const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: walletId }
        });

        if (!wallet) {
          throw new Error(`Wallet not found with ID: ${walletId}`);
        }

        // Calculate and update balance
        const currentBalance = parseFloat(wallet.balance) || 0;
        const transactionAmount = parseFloat(transaction.amount) || 0;
        const newBalance = currentBalance + transactionAmount;

        console.log(`Updating wallet balance from ${currentBalance} to ${newBalance}`);

        // Update wallet balance
        await strapi.db.query('api::user-wallet.user-wallet').update({
          where: { id: walletId },
          data: { balance: newBalance.toString() }
        });

        console.log(`Successfully updated wallet balance to ${newBalance}`);
        
        return { 
          success: true, 
          transaction: transactionId, 
          status,
          walletId,
          previousBalance: currentBalance,
          newBalance,
          message: 'Transaction completed and wallet updated'
        };
      }
      
      // For failed transactions or non-deposits
      return { 
        success: status === 'success', 
        transaction: transactionId, 
        status,
        message: `Transaction status updated to ${status}`
      };
    } catch (error) {
      console.error('Error in updateTransactionById:', error);
      throw error;
    }
  },

  // Handle Stripe webhook
  async webhookStripe(ctx) {
    try {
      console.log('Received Stripe webhook');
      const payload = ctx.request.body;
      
      // In production, verify the webhook signature
      // const signature = ctx.request.headers['stripe-signature'];
      // const event = stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
      
      const event = payload;
      console.log('Stripe webhook event type:', event.type);
      
      if (event.type === 'payment_intent.succeeded') {
        // Extract the payment intent ID which should match our gatewayTransactionId
        const gatewayTransactionId = event.data.object.id;
        console.log('Processing successful Stripe payment:', gatewayTransactionId);
        
        // Update the transaction and wallet
        await this.updateTransactionStatus(gatewayTransactionId, 'success');
        return { success: true, message: 'Payment processed successfully' };
      } 
      else if (event.type === 'payment_intent.payment_failed') {
        const gatewayTransactionId = event.data.object.id;
        console.log('Processing failed Stripe payment:', gatewayTransactionId);
        
        await this.updateTransactionStatus(gatewayTransactionId, 'failed');
        return { success: false, message: 'Payment failed' };
      }
      
      return { received: true, message: 'Webhook received but no action taken' };
    } catch (error) {
      console.error('Error handling Stripe webhook:', error);
      throw error;
    }
  },

  // Handle PayPal webhook
  async webhookPaypal(ctx) {
    try {
      console.log('Received PayPal webhook');
      const payload = ctx.request.body;
      
      // In production, verify the webhook signature with PayPal
      const event = payload;
      console.log('PayPal webhook event type:', event.event_type);
      
      if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
        // Extract the payment ID which should match our gatewayTransactionId
        const gatewayTransactionId = event.resource.id;
        console.log('Processing successful PayPal payment:', gatewayTransactionId);
        
        // Update the transaction and wallet
        await this.updateTransactionStatus(gatewayTransactionId, 'success');
        return { success: true, message: 'Payment processed successfully' };
      } 
      else if (event.event_type === 'PAYMENT.CAPTURE.DENIED' || event.event_type === 'PAYMENT.CAPTURE.FAILED') {
        const gatewayTransactionId = event.resource.id;
        console.log('Processing failed PayPal payment:', gatewayTransactionId);
        
        await this.updateTransactionStatus(gatewayTransactionId, 'failed');
        return { success: false, message: 'Payment failed' };
      }
      
      return { received: true, message: 'Webhook received but no action taken' };
    } catch (error) {
      console.error('Error handling PayPal webhook:', error);
      throw error;
    }
  },

  // Handle Razorpay webhook
  async webhookRazorpay(ctx) {
    try {
      console.log('Received Razorpay webhook');
      const payload = ctx.request.body;
      
      // In production, verify the webhook signature with Razorpay
      // const signature = ctx.request.headers['x-razorpay-signature'];
      // const isValid = validateRazorpayWebhook(payload, signature, process.env.RAZORPAY_WEBHOOK_SECRET);
      
      const event = payload;
      console.log('Razorpay webhook event:', event.event);
      
      if (event.event === 'payment.captured' || event.event === 'payment.authorized') {
        // Extract the payment ID which should match our gatewayTransactionId
        const gatewayTransactionId = event.payload.payment.entity.order_id;
        console.log('Processing successful Razorpay payment:', gatewayTransactionId);
        
        // Update the transaction and wallet
        await this.updateTransactionStatus(gatewayTransactionId, 'success');
        return { success: true, message: 'Payment processed successfully' };
      } 
      else if (event.event === 'payment.failed') {
        const gatewayTransactionId = event.payload.payment.entity.order_id;
        console.log('Processing failed Razorpay payment:', gatewayTransactionId);
        
        await this.updateTransactionStatus(gatewayTransactionId, 'failed');
        return { success: false, message: 'Payment failed' };
      }
      
      return { received: true, message: 'Webhook received but no action taken' };
    } catch (error) {
      console.error('Error handling Razorpay webhook:', error);
      throw error;
    }
  },
  
  // Test webhook for development
  async webhookTest(ctx) {
    try {
      console.log('Received test webhook');
      const payload = ctx.request.body;
      
      // Extract the transaction ID and status from the request
      const { transactionId, status = 'success' } = payload;
      
      if (!transactionId) {
        return ctx.badRequest('Missing transaction ID');
      }
      
      console.log(`Processing test payment for transaction ${transactionId} with status ${status}`);
      
      // Find the transaction
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { id: transactionId }
      });
      
      if (!transaction) {
        return ctx.notFound(`Transaction not found: ${transactionId}`);
      }
      
      // Update the transaction status
      await this.updateTransactionStatus(transaction.gatewayTransactionId || transactionId, status);
      
      return { 
        success: status === 'success', 
        message: `Payment ${status === 'success' ? 'processed successfully' : 'failed'}`
      };
    } catch (error) {
      console.error('Error handling test webhook:', error);
      throw error;
    }
  },
}; 