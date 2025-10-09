'use strict';

/**
 * Admin Payment Gateway Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::global-config.global-config', ({ strapi }) => ({

  /**
   * Get payment gateway settings
   */
  async getPaymentGateways(ctx) {
    try {
      // Find or create the global config
      let config = await strapi.db.query('api::global-config.global-config').findOne({
        where: { publishedAt: { $notNull: true } }
      });

      // If no config exists, create one with defaults
      if (!config) {
        config = await strapi.db.query('api::global-config.global-config').create({
          data: {
            minPayoutAmount: 10,
            autoReleaseDays: 7,
            supportedCurrencies: ['USD'],
            autoApproveDays: 5,
            paymentGateways: {
              stripe: {
                enabled: true,
                displayName: 'Stripe',
                description: 'Credit card payments via Stripe'
              },
              paypal: {
                enabled: true,
                displayName: 'PayPal',
                description: 'PayPal payments'
              },
              razorpay: {
                enabled: true,
                displayName: 'Razorpay',
                description: 'Razorpay payment gateway'
              },
              phonepe: {
                enabled: true,
                displayName: 'PhonePe',
                description: 'PhonePe UPI payments'
              }
            },
            publishedAt: new Date()
          }
        });
      }

      return {
        data: {
          paymentGateways: config.paymentGateways || {}
        }
      };
    } catch (error) {
      console.error('Error fetching payment gateway settings:', error);
      return ctx.internalServerError('Failed to fetch payment gateway settings');
    }
  },

  /**
   * Update payment gateway settings
   */
  async updatePaymentGateways(ctx) {
    try {
      const { paymentGateways } = ctx.request.body;
      const userId = ctx.state?.user?.id;

      if (!paymentGateways || typeof paymentGateways !== 'object') {
        return ctx.badRequest('Invalid payment gateways data');
      }

      // Validate payment gateway structure
      const validGateways = ['stripe', 'paypal', 'razorpay', 'phonepe'];
      for (const [gatewayKey, gatewayData] of Object.entries(paymentGateways)) {
        if (!validGateways.includes(gatewayKey)) {
          return ctx.badRequest(`Invalid payment gateway: ${gatewayKey}`);
        }
        
        if (typeof gatewayData !== 'object' || typeof gatewayData.enabled !== 'boolean') {
          return ctx.badRequest(`Invalid data for gateway: ${gatewayKey}`);
        }
      }

      console.log(`[ADMIN ACTION] Admin ${userId} updating payment gateway settings`, paymentGateways);

      // Find or create the global config
      let config = await strapi.db.query('api::global-config.global-config').findOne({
        where: { publishedAt: { $notNull: true } }
      });

      if (!config) {
        // Create new config with payment gateway settings
        config = await strapi.db.query('api::global-config.global-config').create({
          data: {
            minPayoutAmount: 10,
            autoReleaseDays: 7,
            supportedCurrencies: ['USD'],
            autoApproveDays: 5,
            paymentGateways: paymentGateways,
            publishedAt: new Date()
          }
        });
      } else {
        // Update existing config
        config = await strapi.db.query('api::global-config.global-config').update({
          where: { id: config.id },
          data: {
            paymentGateways: paymentGateways
          }
        });
      }

      // Log the change for audit purposes
      console.log(`[AUDIT] Payment gateway settings updated by admin ${userId}:`, {
        timestamp: new Date().toISOString(),
        adminId: userId,
        changes: paymentGateways
      });

      return {
        data: {
          paymentGateways: config.paymentGateways,
          message: 'Payment gateway settings updated successfully'
        }
      };
    } catch (error) {
      console.error('Error updating payment gateway settings:', error);
      return ctx.internalServerError('Failed to update payment gateway settings');
    }
  },

  /**
   * Get enabled payment gateways (public endpoint for client)
   */
  async getEnabledPaymentGateways(ctx) {
    try {
      // Find the global config
      const config = await strapi.db.query('api::global-config.global-config').findOne({
        where: { publishedAt: { $notNull: true } }
      });

      if (!config || !config.paymentGateways) {
        // Return default enabled gateways if no config exists
        return {
          data: {
            stripe: { enabled: true, displayName: 'Stripe', description: 'Credit card payments via Stripe' },
            paypal: { enabled: true, displayName: 'PayPal', description: 'PayPal payments' },
            razorpay: { enabled: true, displayName: 'Razorpay', description: 'Razorpay payment gateway' },
            phonepe: { enabled: true, displayName: 'PhonePe', description: 'PhonePe UPI payments' }
          }
        };
      }

      // Filter only enabled gateways
      const enabledGateways = {};
      for (const [gatewayKey, gatewayData] of Object.entries(config.paymentGateways)) {
        if (gatewayData.enabled) {
          enabledGateways[gatewayKey] = gatewayData;
        }
      }

      return {
        data: enabledGateways
      };
    } catch (error) {
      console.error('Error fetching enabled payment gateways:', error);
      return ctx.internalServerError('Failed to fetch payment gateway settings');
    }
  }

}));



