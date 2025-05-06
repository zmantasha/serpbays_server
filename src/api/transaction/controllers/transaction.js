'use strict';

/**
 * transaction controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::transaction.transaction', ({ strapi }) => ({
  // Create payment intent
  async createPayment(ctx) {
    try {
      const { amount, currency, gateway } = ctx.request.body;
      const userId = ctx.state.user.id;

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

      // Create pending transaction
      const transaction = await strapi.entityService.create('api::transaction.transaction', {
        data: {
          type: 'deposit',
          amount: amount,
          currency: currency,
          gateway: gateway,
          gatewayTransactionId: paymentData.id,
          transactionStatus: 'pending',
          user_wallet: wallet.id,
          metadata: {
            paymentData: paymentData
          }
        }
      });

      return { data: { transaction, paymentData } };
    } catch (error) {
      return ctx.badRequest(error.message);
    }
  },

  // Handle payment webhook
  async handleWebhook(ctx) {
    try {
      const { gateway } = ctx.params;
      const payload = ctx.request.body;

      let isValid = false;
      let transactionId;

      switch (gateway.toLowerCase()) {
        case 'stripe': {
          const stripeSignature = ctx.request.headers['stripe-signature'];
          const event = stripe.webhooks.constructEvent(
            payload,
            stripeSignature,
            process.env.STRIPE_WEBHOOK_SECRET
          );
          if (event.type === 'payment_intent.succeeded') {
            isValid = true;
            transactionId = event.data.object.id;
          }
          break;
        }

        case 'razorpay': {
          const { order_id, payment_id, razorpaySignature } = payload;
          isValid = await strapi.service('api::transaction.payment').verifyRazorpayPayment(
            order_id,
            payment_id,
            razorpaySignature
          );
          transactionId = order_id;
          break;
        }

        case 'paypal': {
          const { orderID } = payload;
          isValid = await strapi.service('api::transaction.payment').capturePayPalPayment(orderID);
          transactionId = orderID;
          break;
        }

        default:
          return ctx.badRequest('Invalid payment gateway');
      }

      if (isValid) {
        // Update transaction status
        const transaction = await strapi.db.query('api::transaction.transaction').findOne({
          where: { gatewayTransactionId: transactionId }
        });

        if (transaction) {
          await strapi.entityService.update('api::transaction.transaction', transaction.id, {
            data: {
              transactionStatus: 'completed'
            }
          });

          // Update wallet balance
          const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { id: transaction.user_wallet }
          });

          if (wallet) {
            await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
              data: {
                balance: parseFloat(wallet.balance) + parseFloat(transaction.amount)
              }
            });
          }
        }
      }

      return { success: true };
    } catch (error) {
      return ctx.badRequest(error.message);
    }
  }
}));
