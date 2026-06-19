'use strict';

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Razorpay = require('razorpay');
const paypalService = require('./paypal');
const phonepeService = require('./phonepe');
const crypto = require('crypto');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// PayPal service is now imported from separate file

// Audit M11 fix — server-authoritative fee + charge computation.
// Single source of truth for what the gateway is told to charge given the
// wallet-credit amount the user wants. Replaces the previous design where
// the client computed `baseAmount` (wallet credit) AND `totalAmount`
// (gateway charge) and the server trusted both — letting an attacker send
// {amount: 1, baseAmount: 1000} via DevTools and have the wallet credit
// $1000 while only paying $1. With this helper, the controller passes the
// user's `amount` (intent) and the server derives BOTH the gateway charge
// AND the wallet credit deterministically. Any divergence is impossible
// because both values come from the same input via pure math.
const COMPUTE_FEES_GST_RATE = 0.18;        // Razorpay GST on USD base amount

async function computeFees(strapi, gateway, currency, amountUSD) {
  if (typeof amountUSD !== 'number' || !isFinite(amountUSD) || amountUSD <= 0) {
    throw new Error('computeFees: amountUSD must be a positive finite number');
  }
  const upperCurrency = (currency || 'USD').toUpperCase();
  const lowerGateway = (gateway || '').toLowerCase();

  switch (lowerGateway) {
    case 'stripe': {
      // Stripe: no extra processing fee added to user — we absorb it.
      const chargeUSD = amountUSD;
      return {
        gateway: 'stripe',
        walletCreditUSD: amountUSD,           // what wallet gets
        chargeUSD,                            // server-side total in USD
        chargeCurrency: upperCurrency,        // Stripe charges in `currency` directly
        chargeNative: chargeUSD,              // since chargeCurrency == USD
        expectedChargeCents: Math.round(chargeUSD * 100),
        feesApplied: { stripeProcessing: 0 },
        exchangeRate: 1,
      };
    }
    case 'razorpay': {
      // Razorpay: 18% GST on USD base, converted to INR for the actual charge.
      const gstUSD = amountUSD * COMPUTE_FEES_GST_RATE;
      const chargeUSD = amountUSD + gstUSD;
      // Convert to INR using same path as legacy code (so behaviour matches).
      const exchangeRateService = require('../../payment-gateways/services/exchange-rate');
      let inrRate;
      try {
        inrRate = await exchangeRateService.getExchangeRate('USD', 'INR');
      } catch (err) {
        // Same fallback the controller used pre-fix.
        inrRate = parseFloat(process.env.USD_TO_INR_RATE || '83.25');
        strapi.log.warn(`[computeFees] live FX failed, using fallback rate ${inrRate}: ${err.message}`);
      }
      const chargeNative = chargeUSD * inrRate;
      return {
        gateway: 'razorpay',
        walletCreditUSD: amountUSD,
        chargeUSD,
        chargeCurrency: 'INR',
        chargeNative,
        // Razorpay reports amount in paise (₹*100) on webhook.
        expectedChargeCents: Math.round(chargeNative * 100),
        feesApplied: { gstUSD, gstRate: COMPUTE_FEES_GST_RATE },
        exchangeRate: inrRate,
      };
    }
    case 'paypal': {
      const chargeUSD = amountUSD;
      return {
        gateway: 'paypal',
        walletCreditUSD: amountUSD,
        chargeUSD,
        chargeCurrency: upperCurrency,
        chargeNative: chargeUSD,
        expectedChargeCents: Math.round(chargeUSD * 100),
        feesApplied: { paypalProcessing: 0 },
        exchangeRate: 1,
      };
    }
    case 'phonepe': {
      const chargeUSD = amountUSD;
      return {
        gateway: 'phonepe',
        walletCreditUSD: amountUSD,
        chargeUSD,
        chargeCurrency: upperCurrency,
        chargeNative: chargeUSD,
        // PhonePe reports paise too; native is USD here, kept for parity.
        expectedChargeCents: Math.round(chargeUSD * 100),
        feesApplied: { phonepeProcessing: 0 },
        exchangeRate: 1,
      };
    }
    default:
      throw new Error(`computeFees: unknown gateway '${gateway}'`);
  }
}

module.exports = {
  // Audit M11 — server-authoritative fee derivation. Exported so the
  // transaction controller and any future fee-preview endpoint can share
  // ONE math path.
  computeFees: (gateway, currency, amountUSD) => computeFees(strapi, gateway, currency, amountUSD),

  // Create payment intent for Stripe
  async createStripePaymentIntent(amount, currency = 'usd', metadata = {}) {
    try {
      // Use the dedicated Stripe service if available
      const stripeService = strapi.service('api::transaction.stripe-service');
      if (stripeService) {
        return await stripeService.createPaymentIntent(amount, currency, metadata);
      }
      
      // Fallback to basic implementation
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        automatic_payment_methods: {
          enabled: true,
        },
        metadata
      });
      return {
        id: paymentIntent.id,
        client_secret: paymentIntent.client_secret,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        status: paymentIntent.status
      };
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

  // Create PhonePe transaction
  async createPhonePeTransaction(amount, currency = 'INR', metadata = {}) {
    try {
      return await phonepeService.createTransaction(amount, currency, metadata);
    } catch (error) {
      throw new Error(`PhonePe transaction creation failed: ${error.message}`);
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