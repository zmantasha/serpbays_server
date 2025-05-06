import Razorpay from 'razorpay';
import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::payment.razorpay', ({ strapi }) => ({
  async createOrder(amount: number) {
    try {
      const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });

      const order = await razorpay.orders.create({
        amount: amount * 100, // Convert to paise
        currency: 'INR',
        receipt: `receipt_${Date.now()}`,
      });

      return {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
      };
    } catch (error) {
      strapi.log.error('Razorpay order creation failed:', error);
      throw new Error('Failed to create Razorpay order');
    }
  },

  async createPayout(amount: number) {
    try {
      const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });

      const payout = await razorpay.payouts.create({
        account_number: process.env.RAZORPAY_ACCOUNT_NUMBER,
        fund_account_id: process.env.RAZORPAY_FUND_ACCOUNT_ID,
        amount: amount * 100, // Convert to paise
        currency: 'INR',
        mode: 'IMPS',
        purpose: 'payout',
      });

      return {
        id: payout.id,
        amount: payout.amount,
        currency: payout.currency,
        status: payout.status,
      };
    } catch (error) {
      strapi.log.error('Razorpay payout creation failed:', error);
      throw new Error('Failed to create Razorpay payout');
    }
  },

  async verifyPayment(paymentId: string, orderId: string, signature: string) {
    try {
      const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });

      const generatedSignature = razorpay.utils.generateSignature(
        `${orderId}|${paymentId}`,
        process.env.RAZORPAY_KEY_SECRET!
      );

      return generatedSignature === signature;
    } catch (error) {
      strapi.log.error('Razorpay payment verification failed:', error);
      throw new Error('Failed to verify Razorpay payment');
    }
  }
})); 