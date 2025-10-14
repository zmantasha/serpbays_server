'use strict';

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: process.env.STRIPE_API_VERSION || '2023-10-16',
  maxNetworkRetries: 3,
  timeout: 10000
});

module.exports = {
  /**
   * Create a Payment Intent with proper metadata and configuration
   */
  async createPaymentIntent(amount, currency, metadata = {}) {
    try {
      // Validate amount
      const amountInCents = Math.round(amount * 100);
      const minAmount = parseInt(process.env.STRIPE_MIN_AMOUNT || 50);
      const maxAmount = parseInt(process.env.STRIPE_MAX_AMOUNT || 999999);

      if (amountInCents < minAmount) {
        throw new Error(`Amount must be at least $${minAmount / 100}`);
      }

      if (amountInCents > maxAmount) {
        throw new Error(`Amount cannot exceed $${maxAmount / 100}`);
      }

      // Validate currency
      const supportedCurrencies = ['usd', 'eur', 'gbp', 'inr'];
      const normalizedCurrency = currency.toLowerCase();
      if (!supportedCurrencies.includes(normalizedCurrency)) {
        throw new Error(`Currency ${currency} is not supported`);
      }

      console.log(`[STRIPE] Creating Payment Intent: $${amount} ${currency}`);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: normalizedCurrency,
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: {
          ...metadata,
          source: 'serpbays_wallet',
          timestamp: new Date().toISOString()
        },
        statement_descriptor_suffix: process.env.STRIPE_STATEMENT_DESCRIPTOR || 'SERPBAYS',
        description: `Wallet deposit for user ${metadata.userId || 'unknown'}`,
        // Enable 3D Secure when required by the card
        payment_method_options: {
          card: {
            request_three_d_secure: 'automatic'
          }
        }
      });

      console.log(`[STRIPE] ✅ Payment Intent created: ${paymentIntent.id}`);
      
      return {
        id: paymentIntent.id,
        client_secret: paymentIntent.client_secret,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        status: paymentIntent.status
      };
    } catch (error) {
      console.error('[STRIPE] ❌ Payment Intent creation failed:', error);
      throw new Error(`Stripe payment intent creation failed: ${error.message}`);
    }
  },

  /**
   * Retrieve Payment Intent with full details
   */
  async retrievePaymentIntent(paymentIntentId) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      console.log(`[STRIPE] Retrieved Payment Intent: ${paymentIntentId}, Status: ${paymentIntent.status}`);
      return paymentIntent;
    } catch (error) {
      console.error(`[STRIPE] ❌ Failed to retrieve Payment Intent ${paymentIntentId}:`, error);
      throw new Error(`Failed to retrieve payment intent: ${error.message}`);
    }
  },

  /**
   * Update Payment Intent metadata
   */
  async updatePaymentIntent(paymentIntentId, updates) {
    try {
      const paymentIntent = await stripe.paymentIntents.update(paymentIntentId, updates);
      console.log(`[STRIPE] ✅ Payment Intent updated: ${paymentIntentId}`);
      return paymentIntent;
    } catch (error) {
      console.error(`[STRIPE] ❌ Failed to update Payment Intent ${paymentIntentId}:`, error);
      throw new Error(`Failed to update payment intent: ${error.message}`);
    }
  },

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload, signature, secret) {
    try {
      const event = stripe.webhooks.constructEvent(
        payload,
        signature,
        secret || process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log(`[STRIPE] ✅ Webhook signature verified: ${event.type}`);
      return event;
    } catch (error) {
      console.error('[STRIPE] ❌ Webhook signature verification failed:', error);
      throw new Error(`Webhook signature verification failed: ${error.message}`);
    }
  },

  /**
   * Create a refund
   */
  async createRefund(paymentIntentId, amount = null, reason = 'requested_by_customer') {
    try {
      const refundData = {
        payment_intent: paymentIntentId,
        reason
      };

      if (amount) {
        refundData.amount = Math.round(amount * 100);
      }

      const refund = await stripe.refunds.create(refundData);
      console.log(`[STRIPE] ✅ Refund created: ${refund.id} for ${paymentIntentId}`);
      return refund;
    } catch (error) {
      console.error(`[STRIPE] ❌ Refund creation failed for ${paymentIntentId}:`, error);
      throw new Error(`Failed to create refund: ${error.message}`);
    }
  },

  /**
   * Get customer payment methods
   */
  async listCustomerPaymentMethods(customerId) {
    try {
      const paymentMethods = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
      });
      return paymentMethods.data;
    } catch (error) {
      console.error(`[STRIPE] ❌ Failed to list payment methods for ${customerId}:`, error);
      throw new Error(`Failed to list payment methods: ${error.message}`);
    }
  },

  /**
   * Create or retrieve Stripe customer
   */
  async createOrRetrieveCustomer(email, name, metadata = {}) {
    try {
      // Search for existing customer
      const existingCustomers = await stripe.customers.list({
        email: email,
        limit: 1
      });

      if (existingCustomers.data.length > 0) {
        console.log(`[STRIPE] Found existing customer: ${existingCustomers.data[0].id}`);
        return existingCustomers.data[0];
      }

      // Create new customer
      const customer = await stripe.customers.create({
        email,
        name,
        metadata
      });

      console.log(`[STRIPE] ✅ Created new customer: ${customer.id}`);
      return customer;
    } catch (error) {
      console.error('[STRIPE] ❌ Customer creation/retrieval failed:', error);
      throw new Error(`Failed to create/retrieve customer: ${error.message}`);
    }
  },

  /**
   * Cancel a payment intent
   */
  async cancelPaymentIntent(paymentIntentId) {
    try {
      const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId);
      console.log(`[STRIPE] ✅ Payment Intent canceled: ${paymentIntentId}`);
      return paymentIntent;
    } catch (error) {
      console.error(`[STRIPE] ❌ Failed to cancel Payment Intent ${paymentIntentId}:`, error);
      throw new Error(`Failed to cancel payment intent: ${error.message}`);
    }
  }
};

