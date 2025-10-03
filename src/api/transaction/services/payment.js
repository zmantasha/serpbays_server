'use strict';

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Razorpay = require('razorpay');
const paypalService = require('./paypal');
const crypto = require('crypto');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// PayPal service is now imported from separate file

module.exports = {
  // Create payment intent for Stripe
  async createStripePaymentIntent(amount, currency = 'usd') {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        automatic_payment_methods: {
          enabled: true,
        },
      });
      return paymentIntent;
    } catch (error) {
      throw new Error(`Stripe payment intent creation failed: ${error.message}`);
    }
  },

  // Create Razorpay order
  async createRazorpayOrder(amount, currency = 'USD') {
    try {
      const options = {
        amount: Math.round(amount * 100), // Convert to paise
        currency: currency.toUpperCase(),
        receipt: `receipt_${Date.now()}`,
        notes: {
          source: 'serpbays_wallet',
          created_at: new Date().toISOString()
        }
      };
      const order = await razorpay.orders.create(options);
      console.log(`[RAZORPAY] Created order ${order.id} for amount ${amount} ${currency}`);
      return order;
    } catch (error) {
      console.error('[RAZORPAY] Order creation failed:', error);
      throw new Error(`Razorpay order creation failed: ${error.message}`);
    }
  },

  // Create PayPal order
  async createPayPalOrder(amount, currency = 'USD', metadata = {}) {
    try {
      return await paypalService.createOrder(amount, currency, metadata);
    } catch (error) {
      throw new Error(`PayPal order creation failed: ${error.message}`);
    }
  },

  // Verify Stripe payment
  async verifyStripePayment(paymentIntentId) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      return paymentIntent.status === 'succeeded';
    } catch (error) {
      throw new Error(`Stripe payment verification failed: ${error.message}`);
    }
  },

  // Verify Razorpay payment
  async verifyRazorpayPayment(orderId, paymentId, signature) {
    try {
      const generatedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');
      
      return generatedSignature === signature;
    } catch (error) {
      throw new Error(`Razorpay payment verification failed: ${error.message}`);
    }
  },

  // Capture PayPal payment
  async capturePayPalPayment(orderId) {
    try {
      return await paypalService.captureOrder(orderId);
    } catch (error) {
      throw new Error(`PayPal payment capture failed: ${error.message}`);
    }
  },

  // Get PayPal order details
  async getPayPalOrderDetails(orderId) {
    try {
      return await paypalService.getOrderDetails(orderId);
    } catch (error) {
      throw new Error(`PayPal get order details failed: ${error.message}`);
    }
  },

  // Verify PayPal webhook
  async verifyPayPalWebhook(headers, body, webhookId) {
    try {
      return await paypalService.verifyWebhookSignature(headers, body, webhookId);
    } catch (error) {
      throw new Error(`PayPal webhook verification failed: ${error.message}`);
    }
  },

  // Create PayPal payout
  async createPayPalPayout(amount, currency, recipientEmail, metadata = {}) {
    try {
      return await paypalService.createPayout(amount, currency, recipientEmail, metadata);
    } catch (error) {
      throw new Error(`PayPal payout creation failed: ${error.message}`);
    }
  },

  // Get PayPal payout status
  async getPayPalPayoutStatus(batchId) {
    try {
      return await paypalService.getPayoutStatus(batchId);
    } catch (error) {
      throw new Error(`PayPal get payout status failed: ${error.message}`);
    }
  },

  // Refund PayPal payment
  async refundPayPalPayment(captureId, amount = null, reason = 'requested_by_customer') {
    try {
      return await paypalService.refundPayment(captureId, amount, reason);
    } catch (error) {
      throw new Error(`PayPal refund failed: ${error.message}`);
    }
  }
}; 