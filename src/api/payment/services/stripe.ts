import { factories } from '@strapi/strapi';
import Stripe from 'stripe';

export default factories.createCoreService('api::payment.stripe', ({ strapi }) => ({
  getClient() {
    return new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16'
    });
  },

  async createPaymentIntent(amount: number) {
    try {
      const stripe = this.getClient();
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: 'usd',
        automatic_payment_methods: {
          enabled: true,
        },
      });

      return {
        id: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount: paymentIntent.amount,
        status: paymentIntent.status
      };
    } catch (error) {
      strapi.log.error('Stripe payment intent creation failed:', error);
      throw new Error('Failed to create Stripe payment intent');
    }
  },

  async createPayout(amount: number) {
    try {
      const stripe = this.getClient();
      const payout = await stripe.payouts.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: 'usd',
        method: 'standard',
        destination: process.env.STRIPE_DESTINATION_ACCOUNT_ID
      });

      return {
        id: payout.id,
        amount: payout.amount,
        status: payout.status,
        arrival_date: payout.arrival_date
      };
    } catch (error) {
      strapi.log.error('Stripe payout creation failed:', error);
      throw new Error('Failed to create Stripe payout');
    }
  },

  async confirmPayment(paymentIntentId: string) {
    try {
      const stripe = this.getClient();
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      
      if (paymentIntent.status === 'succeeded') {
        return {
          id: paymentIntent.id,
          status: paymentIntent.status,
          amount: paymentIntent.amount
        };
      }

      throw new Error('Payment not succeeded');
    } catch (error) {
      strapi.log.error('Stripe payment confirmation failed:', error);
      throw new Error('Failed to confirm Stripe payment');
    }
  }
})); 