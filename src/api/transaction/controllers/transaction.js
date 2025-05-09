'use strict';

/**
 * transaction controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = createCoreController('api::transaction.transaction', ({ strapi }) => ({
  // Create payment intent
  async createPayment(ctx) {
    try {
      const { amount, currency, gateway } = ctx.request.body;
      const userId = ctx.state?.user?.id;

      // Get user's wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!wallet) {
        return ctx.notFound('Wallet not found');
      }

      let paymentData;
      switch (gateway.toLowerCase()) {
        case 'stripe':
          paymentData = await strapi.service('api::transaction.payment').createStripePaymentIntent(amount, currency);
          break;
        case 'razorpay':
          paymentData = await strapi.service('api::transaction.payment').createRazorpayOrder(amount, currency);
          break;
        case 'paypal':
          paymentData = await strapi.service('api::transaction.payment').createPayPalOrder(amount, currency);
          break;
        default:
          return ctx.badRequest('Invalid payment gateway');
      }

      // For Stripe and PayPal, don't create a transaction yet - just return payment intent
      // We'll let the client create the transaction when the user submits their card details
      console.log("wallet",wallet.id)
      if (gateway.toLowerCase() === 'stripe' || gateway.toLowerCase() === 'paypal') {
        return { data: { 
          walletId: wallet.id,
          paymentData: paymentData 
        }};
      }
      
      // For other payment methods like Razorpay where the flow is different,
      // create a pending transaction immediately
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amount,
          netAmount: amount,
          currency: currency,
          gateway: gateway,
          gatewayTransactionId: paymentData.id,
          transactionStatus: 'pending',
          user_wallet: wallet.id,
          metadata: {
            paymentData: paymentData || { id: paymentData.id }
          },
          publishedAt: new Date()
        },
        populate: ['user_wallet']
      });

      return { data: { transaction, paymentData } };
    } catch (error) {
      console.error("Payment creation error:", error);
      return ctx.badRequest(error.message);
    }
  },

  // Handle payment webhook
  async handleWebhook(ctx) {
    try {
      const { gateway } = ctx.params;
      const payload = ctx.request.body;
      
      // Add detailed logging to troubleshoot
      console.log(`📣 RECEIVED ${gateway.toUpperCase()} WEBHOOK:`, JSON.stringify(payload, null, 2));

      let isValid = false;
      let transactionId;

      switch (gateway.toLowerCase()) {
        case 'stripe': {
          const stripeSignature = ctx.request.headers['stripe-signature'];
          let event;
          
          // For development, we'll process without signature verification
          if (process.env.NODE_ENV === 'development') {
            event = payload;
          } else {
            // Verify signature in production
            try {
              event = stripe.webhooks.constructEvent(
                payload,
                stripeSignature,
                process.env.STRIPE_WEBHOOK_SECRET
              );
            } catch (err) {
              console.error("⚠️ Webhook signature verification failed:", err.message);
              return ctx.badRequest(`Webhook signature verification failed: ${err.message}`);
            }
          }
          
          console.log(`✅ Webhook event type: ${event.type}`);
          
          if (event.type === 'payment_intent.succeeded') {
            isValid = true;
            transactionId = event.data.object.id;
            console.log(`💰 Stripe payment intent ${transactionId} succeeded`);
          } else if (event.type === 'payment_intent.payment_failed') {
            transactionId = event.data.object.id;
            console.log(`❌ Stripe payment intent ${transactionId} failed`);
            return { success: true, status: 'failed' };
          }
          break;
        }

        case 'razorpay': {
          const { order_id, payment_id, razorpay_signature } = payload;
          isValid = await strapi.service('api::transaction.payment').verifyRazorpayPayment(
            order_id,
            payment_id,
            razorpay_signature
          );
          transactionId = order_id;
          break;
        }

        case 'paypal': {
          const orderID = payload.resource ? payload.resource.id : payload.id;
          isValid = await strapi.service('api::transaction.payment').capturePayPalPayment(orderID);
          transactionId = orderID;
          break;
        }

        default:
          return ctx.badRequest('Invalid payment gateway');
      }

      if (isValid) {
        console.log(`🔍 Looking for transaction with gatewayTransactionId: ${transactionId}`);
        
        // Find existing transaction
        const existingTransaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { gatewayTransactionId: transactionId }
        });
        
        if (existingTransaction) {
          console.log(`📝 Found transaction ${existingTransaction.id} with status ${existingTransaction.transactionStatus}`);
          
          // Only update if not already successful
          if (existingTransaction.transactionStatus !== 'success') {
            console.log(`🔄 Updating transaction ${existingTransaction.id} to success`);
            
            // Update transaction status
            await strapi.entityService.update('api::transaction.transaction', existingTransaction.id, {
              data: { transactionStatus: 'success' }
            });
            
            // Find the wallet
            const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
              where: { id: existingTransaction.user_wallet }
            });
            
            if (wallet) {
              const currentBalance = parseFloat(wallet.balance) || 0;
              const transactionAmount = parseFloat(existingTransaction.amount) || 0;
              const newBalance = currentBalance + transactionAmount;
              
              console.log(`💵 Updating wallet ${wallet.id} balance: ${currentBalance} + ${transactionAmount} = ${newBalance}`);
              
              // Update wallet balance
              await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
                data: { balance: newBalance }
              });
              
              console.log(`✅ Wallet balance updated successfully`);
            } else {
              console.error(`❌ Wallet not found for transaction ${existingTransaction.id}`);
            }
          } else {
            console.log(`ℹ️ Transaction ${existingTransaction.id} already successful, skipping`);
          }
        } else {
          console.log(`⚠️ No transaction found with gatewayTransactionId: ${transactionId}`);
          
          // Look for most recent pending transaction with matching amount (fallback)
          const amount = payload.data?.object?.amount ? payload.data.object.amount / 100 : null;
          
          if (amount) {
            console.log(`🔍 Looking for pending transaction with amount: ${amount}`);
            
            const pendingTransactions = await strapi.db.query('api::transaction.transaction').findMany({
              where: { 
                transactionStatus: 'pending',
                amount: amount.toString()
              },
              orderBy: { createdAt: 'DESC' },
              limit: 1
            });
            
            if (pendingTransactions.length > 0) {
              const pendingTransaction = pendingTransactions[0];
              console.log(`📝 Found pending transaction ${pendingTransaction.id} with matching amount ${amount}`);
              
              // Update transaction status
              await strapi.entityService.update('api::transaction.transaction', pendingTransaction.id, {
                data: { 
                  transactionStatus: 'success',
                  gatewayTransactionId: transactionId // Update with correct ID
                }
              });
              
              // Update wallet balance
              const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
                where: { id: pendingTransaction.user_wallet }
              });
              
              if (wallet) {
                const currentBalance = parseFloat(wallet.balance) || 0;
                const transactionAmount = parseFloat(pendingTransaction.amount) || 0;
                const newBalance = currentBalance + transactionAmount;
                
                console.log(`💵 Updating wallet ${wallet.id} balance: ${currentBalance} + ${transactionAmount} = ${newBalance}`);
                
                await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
                  data: { balance: newBalance }
                });
                
                console.log(`✅ Wallet balance updated successfully`);
              }
            } else {
              console.log(`⚠️ No pending transaction found with matching amount: ${amount}`);
            }
          }
        }
      }

      return { success: true };
    } catch (error) {
      console.error('❌ Webhook processing error:', error);
      return ctx.badRequest(error.message);
    }
  },

  // Helper method to mark a transaction as failed
  async markTransactionFailed(gatewayTransactionId) {
    try {
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId },
          transactionStatus: 'pending'
      });
      
      if (transaction) {
        console.log(`Marking transaction ${transaction.id} as failed`);
        await strapi.entityService.update('api::transaction.transaction', transaction.id, {
          data: {
            transactionStatus: 'failed'
          }
        });
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error marking transaction as failed:', error);
      return false;
    }
  },

  // Add a new endpoint to create a pending transaction after payment details are entered
  async createPendingTransaction(ctx) {
    try {
      const { amount, currency, gateway, gatewayTransactionId, walletId } = ctx.request.body;
      
      console.log("Creating pending transaction with data:", {
        amount, currency, gateway, gatewayTransactionId, walletId
      });
      
      // Make sure walletId is a number if your database expects it that way
      const parsedWalletId = parseInt(walletId);
      
      if (isNaN(parsedWalletId)) {
        return ctx.badRequest('Invalid wallet ID');
      }
      
      // Create the transaction
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amount,
          netAmount: amount,
          currency: currency,
          gateway: gateway,
          gatewayTransactionId: gatewayTransactionId,
          transactionStatus: 'pending',
          user_wallet: parsedWalletId, // Use the parsed ID
          metadata: {
            paymentData: { id: gatewayTransactionId }
          },
          publishedAt: new Date()
        }
      });
      
      return { data: transaction };
    } catch (error) {
      console.error("Error creating pending transaction:", error);
      return ctx.badRequest(error.message);
    }
  }
}));
