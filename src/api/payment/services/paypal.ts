import { factories } from '@strapi/strapi';
import axios from 'axios';

export default factories.createCoreService('api::payment.paypal', ({ strapi }) => ({
  getAccessToken: async () => {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const baseURL = process.env.NODE_ENV === 'production'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';

    try {
      const response = await axios.post(`${baseURL}/v1/oauth2/token`, 'grant_type=client_credentials', {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data.access_token;
    } catch (error) {
      strapi.log.error('PayPal authentication failed:', error);
      throw new Error('Failed to authenticate with PayPal');
    }
  },

  async createPayment(amount: number) {
    try {
      const accessToken = await this.getAccessToken();
      const baseURL = process.env.NODE_ENV === 'production'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';

      const response = await axios.post(`${baseURL}/v2/checkout/orders`, {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value: amount.toString()
          }
        }]
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const order = response.data;
      
      return {
        id: order.id,
        status: order.status,
        links: order.links
      };
    } catch (error) {
      strapi.log.error('PayPal payment creation failed:', error);
      throw new Error('Failed to create PayPal payment');
    }
  },

  async createPayout(amount: number) {
    try {
      const accessToken = await this.getAccessToken();
      const baseURL = process.env.NODE_ENV === 'production'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';

      const response = await axios.post(`${baseURL}/v1/payments/payouts`, {
        sender_batch_header: {
          sender_batch_id: `payout_${Date.now()}`,
          email_subject: "You have a payout!"
        },
        items: [{
          recipient_type: "EMAIL",
          amount: {
            value: amount.toString(),
            currency: "USD"
          },
          note: "Thanks for your patronage!",
          receiver: process.env.PAYPAL_RECEIVER_EMAIL,
          sender_item_id: `item_${Date.now()}`
        }]
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const payout = response.data;
      
      return {
        id: payout.batch_header.payout_batch_id,
        status: payout.batch_header.batch_status,
        amount: amount
      };
    } catch (error) {
      strapi.log.error('PayPal payout creation failed:', error);
      throw new Error('Failed to create PayPal payout');
    }
  },

  async capturePayment(orderId: string) {
    try {
      const accessToken = await this.getAccessToken();
      const baseURL = process.env.NODE_ENV === 'production'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';

      const response = await axios.post(`${baseURL}/v2/checkout/orders/${orderId}/capture`, {}, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const capture = response.data;
      
      return {
        id: capture.id,
        status: capture.status,
        amount: capture.purchase_units[0].payments.captures[0].amount.value
      };
    } catch (error) {
      strapi.log.error('PayPal payment capture failed:', error);
      throw new Error('Failed to capture PayPal payment');
    }
  }
})); 