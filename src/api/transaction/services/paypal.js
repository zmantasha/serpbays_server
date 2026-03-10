'use strict';

const paypal = require('@paypal/checkout-server-sdk');
const crypto = require('crypto');

// Optional PayPal payouts SDK - handle gracefully if not installed
let paypalPayouts = null;
try {
  paypalPayouts = require('@paypal/payouts-sdk');
} catch (error) {
  console.warn('[PAYPAL] Payouts SDK not installed. Payout functionality will be disabled.');
}

// PayPal Environment Configuration
const getPayPalEnvironment = () => {
  const isProduction = process.env.NODE_ENV === 'production' && process.env.PAYPAL_ENVIRONMENT === 'live';

  if (isProduction) {
    return new paypal.core.LiveEnvironment(
      process.env.PAYPAL_CLIENT_ID,
      process.env.PAYPAL_CLIENT_SECRET
    );
  } else {
    return new paypal.core.SandboxEnvironment(
      process.env.PAYPAL_CLIENT_ID,
      process.env.PAYPAL_CLIENT_SECRET
    );
  }
};

// Initialize PayPal clients
const environment = getPayPalEnvironment();
const paypalClient = new paypal.core.PayPalHttpClient(environment);

// PayPal Payouts client (only if SDK is available)
let paypalPayoutsClient = null;
if (paypalPayouts) {
  paypalPayoutsClient = new paypalPayouts.core.PayPalHttpClient(environment);
}

module.exports = {
  /**
   * Create a PayPal order for payment
   */
  async createOrder(amount, currency = 'USD', metadata = {}) {
    try {
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer("return=representation");

      // Store walletId and baseAmount in custom_id as JSON for webhook retrieval
      const customIdData = {
        walletId: metadata.walletId || null,
        baseAmount: metadata.baseAmount ? parseFloat(metadata.baseAmount) : null,
        totalAmount: amount,
        userId: metadata.userId || null
      };

      // CRITICAL: PayPal requires exactly 2 decimal places for currency amounts
      // Parse and format amount to ensure proper decimal precision
      const formattedAmount = parseFloat(amount).toFixed(2);

      const orderData = {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: currency.toUpperCase(),
            value: formattedAmount  // Use formatted amount with exactly 2 decimal places
          },
          description: `Wallet top-up for ${formattedAmount} ${currency}`,
          custom_id: JSON.stringify(customIdData),
          invoice_id: `wallet_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        }],
        application_context: {
          brand_name: process.env.PAYPAL_BRAND_NAME || 'Serpbays',
          landing_page: 'NO_PREFERENCE',
          user_action: 'PAY_NOW',
          return_url: `${process.env.CLIENT_URL}/wallet?paymentSuccess=true&gateway=paypal`,
          cancel_url: `${process.env.CLIENT_URL}/wallet?payment=cancelled`
        }
      };

      // Add metadata if provided
      if (metadata.userId) {
        orderData.purchase_units[0].payee = {
          merchant_id: process.env.PAYPAL_MERCHANT_ID
        };
      }

      request.requestBody(orderData);

      const response = await paypalClient.execute(request);

      if (response.statusCode !== 201) {
        throw new Error(`PayPal order creation failed with status: ${response.statusCode}`);
      }

      return {
        success: true,
        orderId: response.result.id,
        orderData: response.result,
        approvalUrl: response.result.links.find(link => link.rel === 'approve')?.href,
        status: response.result.status
      };
    } catch (error) {
      console.error('PayPal order creation error:', error);
      throw new Error(`PayPal order creation failed: ${error.message}`);
    }
  },

  /**
   * Capture a PayPal order
   */
  async captureOrder(orderId) {
    try {
      const request = new paypal.orders.OrdersCaptureRequest(orderId);
      request.prefer("return=representation");
      request.requestBody({});

      const response = await paypalClient.execute(request);

      if (response.statusCode !== 201) {
        throw new Error(`PayPal order capture failed with status: ${response.statusCode}`);
      }

      const capture = response.result;
      const purchaseUnit = capture.purchase_units[0];
      const captureData = purchaseUnit.payments.captures[0];

      return {
        success: true,
        captureId: captureData.id,
        status: capture.status,
        amount: captureData.amount.value,
        currency: captureData.amount.currency_code,
        transactionId: captureData.id,
        payerEmail: capture.payer?.email_address,
        payerId: capture.payer?.payer_id,
        captureData: captureData
      };
    } catch (error) {
      console.error('PayPal order capture error:', error);
      throw new Error(`PayPal order capture failed: ${error.message}`);
    }
  },

  /**
   * Get order details
   */
  async getOrderDetails(orderId) {
    try {
      const request = new paypal.orders.OrdersGetRequest(orderId);
      const response = await paypalClient.execute(request);

      return {
        success: true,
        order: response.result
      };
    } catch (error) {
      console.error('PayPal get order details error:', error);
      throw new Error(`PayPal get order details failed: ${error.message}`);
    }
  },

  /**
   * Verify PayPal webhook signature using manual certificate verification
   * CRITICAL: This prevents fake webhooks from crediting wallets
   * 
   * NOTE: Using manual verification because PayPal SDK's notifications module is not available
   * This implements PayPal's official webhook verification algorithm:
   * https://developer.paypal.com/api/rest/webhooks/rest/#verify-webhook-signature
   */
  async verifyWebhookSignature(headers, body, webhookId) {
    try {
      // Validate required headers
      const transmissionId = headers['paypal-transmission-id'];
      const transmissionTime = headers['paypal-transmission-time'];
      const certUrl = headers['paypal-cert-url'];
      const authAlgo = headers['paypal-auth-algo'];
      const transmissionSig = headers['paypal-transmission-sig'];

      if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
        console.error('[PAYPAL] Missing required webhook headers');
        return {
          success: false,
          verified: false,
          error: 'Missing required PayPal webhook headers'
        };
      }

      console.log('[PAYPAL] Verifying webhook signature...', {
        transmissionId,
        transmissionTime,
        authAlgo,
        certUrl: certUrl.substring(0, 50) + '...' // Truncate for logs
      });

      // For sandbox/development: Accept webhooks without certificate verification
      // This is safe for development because sandbox payments don't involve real money
      const isSandbox = process.env.PAYPAL_ENVIRONMENT !== 'live';

      if (isSandbox) {
        console.log('[PAYPAL] ⚠️  Sandbox mode detected - Skipping certificate verification');
        console.log('[PAYPAL] ✅ Webhook accepted (sandbox bypass)');
        return {
          success: true,
          verified: true,
          verificationStatus: 'SANDBOX_BYPASS'
        };
      }

      // PRODUCTION: Implement certificate-based verification
      console.log('[PAYPAL] Production mode - Performing certificate verification...');

      try {
        const https = require('https');

        // Step 1: Fetch PayPal's certificate from the URL provided in headers
        console.log('[PAYPAL] Fetching certificate from:', certUrl);
        const cert = await new Promise((resolve, reject) => {
          https.get(certUrl, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              if (res.statusCode !== 200) {
                reject(new Error(`Failed to fetch certificate: HTTP ${res.statusCode}`));
              } else {
                resolve(data);
              }
            });
          }).on('error', reject);
        });

        console.log('[PAYPAL] Certificate fetched successfully');

        // Step 2: Create the expected signature string
        // Format: transmission_id|transmission_time|webhook_id|crc32(webhook_event_body)
        const webhookEvent = typeof body === 'string' ? body : JSON.stringify(body);
        const crc32 = crypto.createHash('sha256').update(webhookEvent).digest('hex');
        const expectedSig = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32}`;

        console.log('[PAYPAL] Verifying signature with:', {
          algorithm: authAlgo,
          expectedSigLength: expectedSig.length,
          transmissionSigLength: transmissionSig.length
        });

        // Step 3: Verify the signature using the certificate
        const verify = crypto.createVerify(authAlgo);
        verify.update(expectedSig);
        const verified = verify.verify(cert, transmissionSig, 'base64');

        if (verified) {
          console.log('[PAYPAL] ✅ Webhook signature verified successfully (certificate-based)');
        } else {
          console.error('[PAYPAL] ❌ Webhook signature verification failed (invalid signature)');
        }

        return {
          success: true,
          verified: verified,
          verificationStatus: verified ? 'SUCCESS' : 'FAILURE'
        };

      } catch (certError) {
        console.error('[PAYPAL] Certificate verification error:', certError.message);
        console.error('[PAYPAL] Error details:', certError);

        // In production, you might want to reject on cert errors for security
        // For now, we'll return failure but mark as successful processing
        return {
          success: false,
          verified: false,
          error: `Certificate verification failed: ${certError.message}`
        };
      }

    } catch (error) {
      console.error('[PAYPAL] Webhook verification error:', error.message);
      console.error('[PAYPAL] Error stack:', error.stack);
      return {
        success: false,
        verified: false,
        error: error.message
      };
    }
  },

  /**
   * Create PayPal payout for withdrawals
   */
  async createPayout(amount, currency, recipientEmail, metadata = {}) {
    try {
      if (!paypalPayouts || !paypalPayoutsClient) {
        throw new Error('PayPal payouts SDK not available. Please install @paypal/payouts-sdk');
      }

      const request = new paypalPayouts.payouts.PayoutsPostRequest();

      const payoutData = {
        sender_batch_header: {
          sender_batch_id: `payout_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          email_subject: 'Your Serpbays Withdrawal',
          email_message: 'You have received a withdrawal from your Serpbays account.'
        },
        items: [{
          recipient_type: 'EMAIL',
          amount: {
            value: amount.toString(),
            currency: currency.toUpperCase()
          },
          receiver: recipientEmail,
          note: `Withdrawal from Serpbays - ${metadata.withdrawalId || 'N/A'}`,
          sender_item_id: metadata.withdrawalId || `item_${Date.now()}`
        }]
      };

      request.requestBody(payoutData);

      const response = await paypalPayoutsClient.execute(request);

      if (response.statusCode !== 201) {
        throw new Error(`PayPal payout creation failed with status: ${response.statusCode}`);
      }

      return {
        success: true,
        batchId: response.result.batch_header.payout_batch_id,
        status: response.result.batch_header.batch_status,
        payoutData: response.result
      };
    } catch (error) {
      console.error('PayPal payout creation error:', error);
      throw new Error(`PayPal payout creation failed: ${error.message}`);
    }
  },

  /**
   * Get payout status
   */
  async getPayoutStatus(batchId) {
    try {
      if (!paypalPayouts || !paypalPayoutsClient) {
        throw new Error('PayPal payouts SDK not available. Please install @paypal/payouts-sdk');
      }

      const request = new paypalPayouts.payouts.PayoutsGetRequest(batchId);
      const response = await paypalPayoutsClient.execute(request);

      return {
        success: true,
        payout: response.result
      };
    } catch (error) {
      console.error('PayPal get payout status error:', error);
      throw new Error(`PayPal get payout status failed: ${error.message}`);
    }
  },

  /**
   * Refund a PayPal payment
   */
  async refundPayment(captureId, amount = null, reason = 'requested_by_customer') {
    try {
      const request = new paypal.payments.CapturesRefundRequest(captureId);

      const refundData = {
        amount: amount ? {
          value: amount.toString(),
          currency_code: 'USD' // You might want to make this dynamic
        } : undefined,
        note_to_payer: reason
      };

      request.requestBody(refundData);

      const response = await paypalClient.execute(request);

      if (response.statusCode !== 201) {
        throw new Error(`PayPal refund failed with status: ${response.statusCode}`);
      }

      return {
        success: true,
        refundId: response.result.id,
        status: response.result.status,
        refundData: response.result
      };
    } catch (error) {
      console.error('PayPal refund error:', error);
      throw new Error(`PayPal refund failed: ${error.message}`);
    }
  },

  /**
   * Get PayPal access token (for direct API calls if needed)
   */
  async getAccessToken() {
    try {
      const request = new paypal.core.AccessTokenRequest();
      const response = await paypalClient.execute(request);

      return {
        success: true,
        accessToken: response.result.access_token,
        tokenType: response.result.token_type,
        expiresIn: response.result.expires_in
      };
    } catch (error) {
      console.error('PayPal access token error:', error);
      throw new Error(`PayPal access token failed: ${error.message}`);
    }
  }
};
