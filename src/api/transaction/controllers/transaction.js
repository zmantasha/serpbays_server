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
      
      console.log(`Received ${gateway} webhook:`, JSON.stringify(payload, null, 2));

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
            console.log(`Stripe payment intent ${transactionId} succeeded`);
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

      if (isValid) {
        // Retrieve the stored payment intent data
        const paymentIntent = await strapi.service('api::transaction.payment').getPaymentIntent(transactionId);
        
        if (!paymentIntent) {
          console.error(`No payment intent data found for ID: ${transactionId}`);
          return ctx.notFound('Payment intent data not found');
        }
        
        // NOW create the transaction with success status
        const transaction = await strapi.entityService.create('api::transaction.transaction', {
          data: {
            type: 'deposit',
            amount: paymentIntent.amount,
            netAmount: paymentIntent.amount,
            currency: paymentIntent.currency,
            gateway: paymentIntent.gateway,
            gatewayTransactionId: transactionId,
            transactionStatus: 'success', // Create directly as success
            user_wallet: paymentIntent.walletId,
            metadata: {
              paymentData: { id: transactionId }
            },
            publishedAt: new Date()
          },
        });
        
        console.log(`Created successful transaction ${transaction.id} for wallet ${paymentIntent.walletId}`);
        
        // Update wallet balance
        const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
          where: { id: paymentIntent.walletId }
        });
        
        if (!wallet) {
          console.error(`Wallet not found with ID: ${paymentIntent.walletId}`);
          return ctx.notFound('Wallet not found');
        }
        
        const currentBalance = parseFloat(wallet.balance) || 0;
        const transactionAmount = parseFloat(paymentIntent.amount) || 0;
        const newBalance = currentBalance + transactionAmount;
        
        console.log(`Updating wallet ${wallet.id} balance from ${currentBalance} to ${newBalance}`);
        
        // Update balance
        await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
          data: {
            balance: newBalance
          }
        });
        
        // Clean up the stored payment intent
        await strapi.service('api::transaction.payment').removePaymentIntent(transactionId);
        
        console.log(`Transaction created and wallet ${wallet.id} successfully updated`);
      }

      // Always return success to the payment gateway to acknowledge receipt
      return { success: true };
    } catch (error) {
      console.error('Webhook processing error:', error);
      return ctx.badRequest(error.message);
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
