'use strict';

const exchangeRateService = require('../services/exchange-rate');

/**
 * Payment Gateways Controller
 * Handles payment gateway configuration and fee calculations
 */

module.exports = {
  /**
   * Get enabled payment gateways
   */
  async getEnabled(ctx) {
    try {
      // Get payment gateway settings from environment or database
      const enabledGateways = {
        stripe: {
          enabled: process.env.STRIPE_ENABLED === 'true',
          displayName: 'Stripe',
          description: 'Credit card payments via Stripe',
          feePercentage: parseFloat(process.env.STRIPE_FEE_PERCENTAGE || '2.9'),
          fixedFee: parseFloat(process.env.STRIPE_FIXED_FEE || '0.30')
        },
        paypal: {
          enabled: process.env.PAYPAL_ENABLED === 'true',
          displayName: 'PayPal',
          description: 'PayPal payments',
          feePercentage: parseFloat(process.env.PAYPAL_FEE_PERCENTAGE || '3.49'),
          fixedFee: parseFloat(process.env.PAYPAL_FIXED_FEE || '0.49')
        },
        razorpay: {
          enabled: process.env.RAZORPAY_ENABLED === 'true',
          displayName: 'Razorpay',
          description: 'Razorpay payment gateway',
          feePercentage: parseFloat(process.env.RAZORPAY_FEE_PERCENTAGE || '0'),
          gstPercentage: parseFloat(process.env.RAZORPAY_GST_PERCENTAGE || '18.0'),
          conversionRate: parseFloat(process.env.USD_TO_INR_RATE || '83.25')
        },
        phonepe: {
          enabled: process.env.PHONEPE_ENABLED === 'true',
          displayName: 'PhonePe',
          description: 'PhonePe UPI payments',
          feePercentage: parseFloat(process.env.PHONEPE_FEE_PERCENTAGE || '0'),
          gstPercentage: parseFloat(process.env.PHONEPE_GST_PERCENTAGE || '18.0')
        },
        bank_transfer: {
          enabled: true,
          displayName: 'Bank Transfer',
          description: 'Manual bank transfer with zero fees',
          feePercentage: 0,
          fixedFee: 0
        }
      };

      // Filter only enabled gateways
      const filteredGateways = {};
      Object.keys(enabledGateways).forEach(key => {
        if (enabledGateways[key].enabled) {
          filteredGateways[key] = enabledGateways[key];
        }
      });

      ctx.send({
        data: filteredGateways
      });

    } catch (error) {
      console.error('[PAYMENT GATEWAYS] Error fetching enabled gateways:', error);
      return ctx.internalServerError('Failed to fetch payment gateways');
    }
  },

  /**
   * Calculate payment fees for a given amount and payment method
   */
  async calculateFees(ctx) {
    try {
      const { amount, paymentMethod, currency = 'USD' } = ctx.request.body;

      // Validate input
      if (!amount || !paymentMethod) {
        return ctx.badRequest('Amount and payment method are required');
      }

      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return ctx.badRequest('Invalid amount');
      }

      const baseAmount = parsedAmount;
      let feeAmount = 0;
      let feePercentage = 0;
      let convertedAmount = undefined;
      let conversionRate = undefined;
      let breakdown = {};

      switch (paymentMethod.toLowerCase()) {
        case 'stripe':
          // Stripe: 2.9% + $0.30
          const stripeFeePercentage = parseFloat(process.env.STRIPE_FEE_PERCENTAGE || '2.9');
          const stripeFixedFee = parseFloat(process.env.STRIPE_FIXED_FEE || '0.30');
          const stripeProcessingFee = baseAmount * (stripeFeePercentage / 100);
          feeAmount = stripeProcessingFee + stripeFixedFee;
          feePercentage = stripeFeePercentage;
          breakdown = {
            processingFee: stripeProcessingFee,
            fixedFee: stripeFixedFee
          };
          break;

        case 'paypal':
          // PayPal: 3.49% + $0.49
          const paypalFeePercentage = parseFloat(process.env.PAYPAL_FEE_PERCENTAGE || '3.49');
          const paypalFixedFee = parseFloat(process.env.PAYPAL_FIXED_FEE || '0.49');
          const paypalProcessingFee = baseAmount * (paypalFeePercentage / 100);
          feeAmount = paypalProcessingFee + paypalFixedFee;
          feePercentage = paypalFeePercentage;
          breakdown = {
            processingFee: paypalProcessingFee,
            fixedFee: paypalFixedFee
          };
          break;

        case 'razorpay':
          // Razorpay: Processing fee (0 by default, configurable) + GST (18% on base amount)
          const razorpayFeePercentage = parseFloat(process.env.RAZORPAY_FEE_PERCENTAGE || '0');
          const razorpayGstPercentage = parseFloat(process.env.RAZORPAY_GST_PERCENTAGE || '18.0');
          const razorpayProcessingFee = baseAmount * (razorpayFeePercentage / 100);
          const razorpayGstFee = baseAmount * (razorpayGstPercentage / 100);
          feeAmount = razorpayProcessingFee + razorpayGstFee;
          feePercentage = razorpayFeePercentage;
          breakdown = {
            processingFee: razorpayProcessingFee,
            gstFee: razorpayGstFee
          };

          // USD to INR conversion using real-time exchange rate
          try {
            conversionRate = await exchangeRateService.getExchangeRate('USD', 'INR');
          } catch (err) {
            console.error('[PAYMENT GATEWAYS] Failed to get exchange rate, using fallback:', err.message);
            conversionRate = parseFloat(process.env.USD_TO_INR_RATE || '83.25');
          }
          convertedAmount = (baseAmount + feeAmount) * conversionRate;
          break;

        case 'phonepe':
          // PhonePe: Processing fee (0 by default, configurable) + GST (18% on base amount)
          const phonepeFeePercentage = parseFloat(process.env.PHONEPE_FEE_PERCENTAGE || '0');
          const phonepeGstPercentage = parseFloat(process.env.PHONEPE_GST_PERCENTAGE || '18.0');
          const phonepeProcessingFee = baseAmount * (phonepeFeePercentage / 100);
          const phonepeGstFee = baseAmount * (phonepeGstPercentage / 100);
          feeAmount = phonepeProcessingFee + phonepeGstFee;
          feePercentage = phonepeFeePercentage;
          breakdown = {
            processingFee: phonepeProcessingFee,
            gstFee: phonepeGstFee
          };

          // USD to INR conversion using real-time exchange rate
          try {
            conversionRate = await exchangeRateService.getExchangeRate('USD', 'INR');
          } catch (err) {
            console.error('[PAYMENT GATEWAYS] Failed to get exchange rate, using fallback:', err.message);
            conversionRate = parseFloat(process.env.USD_TO_INR_RATE || '83.25');
          }
          convertedAmount = (baseAmount + feeAmount) * conversionRate;
          break;

        case 'bank_transfer':
          // Bank Transfer: No fees
          feeAmount = 0;
          feePercentage = 0;
          breakdown = {
            processingFee: 0
          };
          break;

        default:
          return ctx.badRequest('Invalid payment method');
      }

      const response = {
        baseAmount,
        feeAmount,
        totalAmount: baseAmount + feeAmount,
        feePercentage,
        currency: paymentMethod.toLowerCase() === 'razorpay' || paymentMethod.toLowerCase() === 'phonepe' ? 'INR' : 'USD',
        convertedAmount,
        conversionRate,
        breakdown
      };

      ctx.send({
        data: response
      });

    } catch (error) {
      console.error('[PAYMENT GATEWAYS] Error calculating fees:', error);
      return ctx.internalServerError('Failed to calculate payment fees');
    }
  },

  /**
   * Update payment gateway settings (admin only)
   */
  async updateSettings(ctx) {
    try {
      const { gateway, settings } = ctx.request.body;

      if (!gateway || !settings) {
        return ctx.badRequest('Gateway and settings are required');
      }

      // In a real implementation, you would save these settings to a database
      // For now, we'll just return success
      console.log(`[PAYMENT GATEWAYS] Updating settings for ${gateway}:`, settings);

      ctx.send({
        message: `Settings updated for ${gateway}`,
        gateway,
        settings
      });

    } catch (error) {
      console.error('[PAYMENT GATEWAYS] Error updating settings:', error);
      return ctx.internalServerError('Failed to update payment gateway settings');
    }
  }
};
