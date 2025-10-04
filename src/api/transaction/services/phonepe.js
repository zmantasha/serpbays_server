'use strict';

const crypto = require('crypto');
const axios = require('axios');

/**
 * PhonePe Payment Gateway Service
 * Professional implementation following Razorpay pattern
 */

class PhonePeService {
  constructor() {
    this.merchantId = process.env.PHONEPE_MERCHANT_ID;
    this.saltKey = process.env.PHONEPE_SALT_KEY;
    this.saltIndex = process.env.PHONEPE_SALT_INDEX || '1';
    this.mode = process.env.PHONEPE_MODE || 'sandbox';
    
    // PhonePe API endpoints
    this.baseUrl = this.mode === 'production'
      ? 'https://api.phonepe.com/apis/hermes'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox';
    console.log(`[PHONEPE] Initialized in ${this.mode} mode`);
    console.log(`[PHONEPE] Merchant ID: ${this.merchantId}`);
    console.log(`[PHONEPE] Salt Key: ${this.saltKey ? 'Set' : 'Missing'}`);
  }
  

  /**
   * Generate PhonePe signature
   * Format: SHA256(base64_payload + endpoint + salt_key) + ### + salt_index
   */
  generateSignature(base64Payload, endpoint = '/pg/v1/pay') {
    const string = base64Payload + endpoint + this.saltKey;
    const sha256Hash = crypto.createHash('sha256').update(string).digest('hex');
    return `${sha256Hash}###${this.saltIndex}`;
  }

  /**
   * Verify PhonePe callback signature
   */
  verifySignature(base64Response, receivedSignature) {
    const string = base64Response + this.saltKey;
    const sha256Hash = crypto.createHash('sha256').update(string).digest('hex');
    const expectedSignature = `${sha256Hash}###${this.saltIndex}`;
    return expectedSignature === receivedSignature;
  }

  /**
   * Create PhonePe transaction
   * Similar to Razorpay createOrder
   */
  async createTransaction(amount, currency = 'INR', metadata = {}) {
    console.log(this.merchantId)
    console.log(this.saltKey)
    try {
      if (!this.merchantId || !this.saltKey) {
        throw new Error('PhonePe credentials not configured');
      }

      // Generate unique merchant transaction ID
      const merchantTransactionId = `TXN_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      // PhonePe requires amount in paise (smallest currency unit)
      const amountInPaise = Math.round(amount * 100);

      // Build payment request
      const paymentRequest = {
        merchantId: this.merchantId,
        merchantTransactionId: merchantTransactionId,
        merchantUserId: metadata.userId ? `USER_${metadata.userId}` : `USER_${Date.now()}`,
        amount: amountInPaise,
        redirectUrl: metadata.redirectUrl || `${process.env.CLIENT_URL || 'http://localhost:3000'}/wallet?phonepe_callback=true`,
        redirectMode: 'POST',
        callbackUrl: `${process.env.API_URL || 'http://localhost:1337'}/api/api/transactions/phonepe-callback`,
        mobileNumber: metadata.mobileNumber || '',
        paymentInstrument: {
          type: 'PAY_PAGE'
        }
      };
      console.log("payment",paymentRequest)

      // Convert to base64
      const base64Payload = Buffer.from(JSON.stringify(paymentRequest)).toString('base64');

      // Generate signature
      const signature = this.generateSignature(base64Payload);
  console.log("signature",signature)
      // Make API request
      const response = await axios.post(
        `${this.baseUrl}/pg/v1/pay`,
        
        {
          headers: {
            'Content-Type': 'application/json',
            'X-VERIFY': signature
          },
          data:{
            request: base64Payload
          },
        }
      );
console.log("response",response)
      if (response.data.success) {
        console.log(`[PHONEPE] Transaction created: ${merchantTransactionId}`);
        
        return {
          success: true,
          transactionId: merchantTransactionId,
          merchantId: this.merchantId,
          amount: amount,
          currency: currency,
          redirectUrl: response.data.data.instrumentResponse.redirectInfo.url,
          data: response.data.data
        };
      } else {
        throw new Error(response.data.message || 'Transaction creation failed');
      }

    } catch (error) {
      console.error('[PHONEPE] Transaction creation error:', error.message);
      if (error.response) {
        console.error('[PHONEPE] API Response:', error.response.data);
      }
      throw new Error(`PhonePe transaction creation failed: ${error.message}`);
    }
  }

  /**
   * Check transaction status
   * Used for polling after redirect
   */
  async checkTransactionStatus(merchantTransactionId) {
    try {
      if (!merchantTransactionId) {
        throw new Error('Transaction ID is required');
      }

      const endpoint = `/pg/v1/status/${this.merchantId}/${merchantTransactionId}`;
      const signature = this.generateSignature('', endpoint);

      const response = await axios.get(
        `${this.baseUrl}${endpoint}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-VERIFY': signature,
            'X-MERCHANT-ID': this.merchantId
          }
        }
      );

      if (response.data.success) {
        const paymentData = response.data.data;
        
        console.log(`[PHONEPE] Status check for ${merchantTransactionId}: ${paymentData.state}`);

        return {
          success: true,
          transactionId: merchantTransactionId,
          state: paymentData.state,
          paymentInstrument: paymentData.paymentInstrument,
          amount: paymentData.amount / 100, // Convert back from paise
          responseCode: paymentData.responseCode,
          data: paymentData
        };
      } else {
        throw new Error(response.data.message || 'Status check failed');
      }

    } catch (error) {
      console.error('[PHONEPE] Status check error:', error.message);
      throw new Error(`PhonePe status check failed: ${error.message}`);
    }
  }

  /**
   * Handle callback from PhonePe
   * Similar to Razorpay webhook handling
   */
  async handleCallback(base64Response, signature) {
    try {
      // Verify signature
      const isValid = this.verifySignature(base64Response, signature);
      
      if (!isValid) {
        console.error('[PHONEPE] Invalid callback signature');
        return { success: false, error: 'Invalid signature' };
      }

      // Decode response
      const responseData = JSON.parse(Buffer.from(base64Response, 'base64').toString());

      console.log(`[PHONEPE] Callback received for ${responseData.data.merchantTransactionId}: ${responseData.data.state}`);

      return {
        success: true,
        transactionId: responseData.data.merchantTransactionId,
        state: responseData.data.state,
        amount: responseData.data.amount / 100, // Convert from paise
        paymentInstrument: responseData.data.paymentInstrument,
        responseCode: responseData.code,
        data: responseData.data
      };

    } catch (error) {
      console.error('[PHONEPE] Callback handling error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Initiate refund
   * For future use
   */
  async initiateRefund(merchantTransactionId, amount, reason = 'Customer request') {
    try {
      const refundTransactionId = `REFUND_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      const refundRequest = {
        merchantId: this.merchantId,
        merchantTransactionId: refundTransactionId,
        originalTransactionId: merchantTransactionId,
        amount: Math.round(amount * 100), // Convert to paise
        callbackUrl: `${process.env.API_URL || 'http://localhost:1337'}/api/api/transactions/phonepe-refund-callback`
      };

      const base64Payload = Buffer.from(JSON.stringify(refundRequest)).toString('base64');
      const signature = this.generateSignature(base64Payload, '/pg/v1/refund');

      const response = await axios.post(
        `${this.baseUrl}/pg/v1/refund`,
        {
          request: base64Payload
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-VERIFY': signature
          }
        }
      );

      if (response.data.success) {
        console.log(`[PHONEPE] Refund initiated: ${refundTransactionId} for ${merchantTransactionId}`);
        return {
          success: true,
          refundId: refundTransactionId,
          data: response.data.data
        };
      } else {
        throw new Error(response.data.message || 'Refund initiation failed');
      }

    } catch (error) {
      console.error('[PHONEPE] Refund error:', error.message);
      throw new Error(`PhonePe refund failed: ${error.message}`);
    }
  }
}

// Export singleton instance
module.exports = new PhonePeService();
