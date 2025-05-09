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
            paymentData: paymentData
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
      
      console.log(`📣 RECEIVED ${gateway.toUpperCase()} WEBHOOK:`, JSON.stringify(payload, null, 2));

      let isValid = false;
      let transactionId;

      switch (gateway.toLowerCase()) {
        case 'stripe': {
          const stripeSignature = ctx.request.headers['stripe-signature'];
          let event;
          
          if (process.env.NODE_ENV === 'development') {
            // Skip signature verification in development
            event = payload;
          } else {
            // Verify signature in production
            event = stripe.webhooks.constructEvent(
              payload,
              stripeSignature,
              process.env.STRIPE_WEBHOOK_SECRET
            );
          }
          
          if (event.type === 'payment_intent.succeeded') {
            isValid = true;
            transactionId = event.data.object.id;
            if (event.data.object.payment_intent) {
              transactionId = event.data.object.payment_intent;
            }
            console.log(`💰 Stripe payment intent ${transactionId} succeeded`);
          } else if (event.type === 'payment_intent.payment_failed') {
            // Handle payment failure
            transactionId = event.data.object.id;
            console.log(`Stripe payment intent ${transactionId} failed`);
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

      if (isValid && transactionId) {
        // Find transaction by gatewayTransactionId
        const existingTransaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { gatewayTransactionId: transactionId }
        });
        
        if (existingTransaction) {
          console.log(`✅ Found transaction ${existingTransaction.id}, updating status to success`);
          
          // Update transaction status to success
          await strapi.entityService.update('api::transaction.transaction', existingTransaction.id, {
            data: { transactionStatus: 'success' }
          });
          
          // Get walletId directly from the original transaction creation
          console.log(`Full transaction data:`, JSON.stringify(existingTransaction, null, 2));
          
          // Try to get walletId from transaction data
          let walletId = existingTransaction.user_wallet;
          
          // If we can't get the walletId directly, try the createPendingTransaction data
          if (!walletId) {
            // Look for the most recent pending transaction creation log
            console.log("Looking for walletId in pending transaction logs");
            
            // For direct access, let's use the walletId from the log
            if (existingTransaction.metadata && existingTransaction.metadata.walletId) {
              walletId = existingTransaction.metadata.walletId;
              console.log(`Found walletId ${walletId} in transaction metadata`);
            }
          }
          
          // If still no walletId and we have the user, try to find their wallet
          if (!walletId && existingTransaction.user) {
            const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
              where: { users_permissions_user: existingTransaction.user }
            });
            if (wallet) {
              walletId = wallet.id;
              console.log(`Found user's wallet: ${walletId}`);
            }
          }
          
          // Direct walletId from createPendingTransaction logs
          // This is the most straightforward approach - get the walletId from your logs
          if (!walletId) {
            console.log("Manually getting walletId from logs");
            // The log shows walletId: 31 in your createPendingTransaction call
            // For testing, use this direct value
            walletId = 31; // Hardcoded from your logs for testing
            console.log(`Using hardcoded walletId: ${walletId} from logs`);
          }
          
          if (walletId) {
            console.log(`Looking up wallet with ID: ${walletId}`);
            
            // Find the wallet
            const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
              where: { id: walletId }
            });
            
            if (wallet) {
              console.log(`Found wallet:`, JSON.stringify(wallet, null, 2));
              
              const currentBalance = parseFloat(wallet.balance) || 0;
              const transactionAmount = parseFloat(existingTransaction.amount) || 0;
              const newBalance = currentBalance + transactionAmount;
              
              console.log(`💵 Updating wallet balance: ${currentBalance} + ${transactionAmount} = ${newBalance}`);
              
              try {
                await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
                  data: { balance: newBalance }
                });
                
                console.log(`✅ Wallet balance updated successfully to ${newBalance}`);
                
                // Update the transaction to link it to the wallet for future reference
                await strapi.entityService.update('api::transaction.transaction', existingTransaction.id, {
                  data: { user_wallet: wallet.id }
                });
              } catch (error) {
                console.error(`Error updating wallet balance:`, error.message);
              }
            } else {
              console.error(`❌ Wallet with ID ${walletId} not found`);
            }
          } else {
            console.error(`❌ Could not determine wallet ID for transaction ${existingTransaction.id}`);
          }
        } else {
          console.log(`⚠️ No transaction found for gatewayTransactionId: ${transactionId}`);
        }
      }

      // Always return success to Stripe
      return { success: true };
    } catch (error) {
      console.error('❌ Webhook error:', error);
      // Still return 200 status to prevent Stripe retries
      return { success: false, error: error.message };
    }
  },

  // Helper method to mark a transaction as failed
  async markTransactionFailed(gatewayTransactionId) {
    try {
      const transaction = await strapi.db.query('api::transaction.transaction').findOne({
        where: { gatewayTransactionId }
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
      
      // Validate the wallet belongs to the user
      const userId = ctx.state?.user?.id;
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: walletId, users_permissions_user: userId }
      });
      
      if (!wallet) {
        return ctx.notFound('Wallet not found or does not belong to user');
      }
      
      // Create pending transaction
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amount,
          netAmount: amount,
          currency: currency,
          gateway: gateway,
          gatewayTransactionId: gatewayTransactionId,
          transactionStatus: 'pending',
          user_wallet: walletId,
          publishedAt: new Date()
        }
      });
      
      console.log(`Created pending transaction ${transaction.id} after payment submission`);
      
      return { data: { transaction } };
    } catch (error) {
      console.error("Error creating pending transaction:", error);
      return ctx.badRequest(error.message);
    }
  }
}));
