'use strict';

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Razorpay = require('razorpay');
const paypal = require('@paypal/checkout-server-sdk');
const crypto = require('crypto');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Initialize PayPal
const environment = new paypal.core.SandboxEnvironment(
  process.env.PAYPAL_CLIENT_ID,
  process.env.PAYPAL_CLIENT_SECRET
);
const paypalClient = new paypal.core.PayPalHttpClient(environment);

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
  async createRazorpayOrder(amount, currency = 'INR') {
    try {
      const options = {
        amount: Math.round(amount * 100), // Convert to paise
        currency: currency.toUpperCase(),
        receipt: `receipt_${Date.now()}`,
      };
      const order = await razorpay.orders.create(options);
      return order;
    } catch (error) {
      throw new Error(`Razorpay order creation failed: ${error.message}`);
    }
  },

  // Create PayPal order
  async createPayPalOrder(amount, currency = 'USD') {
    try {
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer("return=representation");
      request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: currency.toUpperCase(),
            value: amount.toString()
          }
        }]
      });

      const order = await paypalClient.execute(request);
      return order.result;
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
      const request = new paypal.orders.OrdersCaptureRequest(orderId);
      const capture = await paypalClient.execute(request);
      return capture.result.status === 'COMPLETED';
    } catch (error) {
      throw new Error(`PayPal payment capture failed: ${error.message}`);
    }
  }
}; 