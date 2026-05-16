'use strict';

/**
 * Payment Gateways Service
 */

module.exports = {
  /**
   * Get fee configuration for a payment gateway
   */
  getFeeConfig(gateway) {
    const configs = {
      stripe: {
        feePercentage: parseFloat(process.env.STRIPE_FEE_PERCENTAGE || '2.9'),
        fixedFee: parseFloat(process.env.STRIPE_FIXED_FEE || '0.30'),
        currency: 'USD'
      },
      paypal: {
        feePercentage: parseFloat(process.env.PAYPAL_FEE_PERCENTAGE || '3.49'),
        fixedFee: parseFloat(process.env.PAYPAL_FIXED_FEE || '0.49'),
        currency: 'USD'
      },
      razorpay: {
        feePercentage: parseFloat(process.env.RAZORPAY_FEE_PERCENTAGE || '2.0'),
        gstPercentage: parseFloat(process.env.RAZORPAY_GST_PERCENTAGE || '18.0'),
        conversionRate: parseFloat(process.env.USD_TO_INR_RATE || '83.25'),
        currency: 'INR'
      },
      phonepe: {
        feePercentage: parseFloat(process.env.PHONEPE_FEE_PERCENTAGE || '2.0'),
        gstPercentage: parseFloat(process.env.PHONEPE_GST_PERCENTAGE || '18.0'),
        conversionRate: parseFloat(process.env.USD_TO_INR_RATE || '83.25'),
        currency: 'INR'
      }
    };

    return configs[gateway.toLowerCase()] || null;
  },

  /**
   * Calculate fees for a specific gateway
   */
  calculateGatewayFees(amount, gateway) {
    const config = this.getFeeConfig(gateway);
    if (!config) {
      throw new Error(`Unknown payment gateway: ${gateway}`);
    }

    const baseAmount = parseFloat(amount);
    let feeAmount = 0;
    let breakdown = {};

    switch (gateway.toLowerCase()) {
      case 'stripe':
      case 'paypal':
        const processingFee = baseAmount * (config.feePercentage / 100);
        feeAmount = processingFee + config.fixedFee;
        breakdown = {
          processingFee,
          fixedFee: config.fixedFee
        };
        break;

      case 'razorpay':
      case 'phonepe':
        const baseFee = baseAmount * (config.feePercentage / 100);
        const gstFee = baseFee * (config.gstPercentage / 100);
        feeAmount = baseFee + gstFee;
        breakdown = {
          processingFee: baseFee,
          gstFee
        };
        break;
    }

    return {
      baseAmount,
      feeAmount,
      totalAmount: baseAmount + feeAmount,
      feePercentage: config.feePercentage,
      currency: config.currency,
      breakdown,
      conversionRate: config.conversionRate,
      convertedAmount: config.conversionRate ? (baseAmount + feeAmount) * config.conversionRate : undefined
    };
  }
};

