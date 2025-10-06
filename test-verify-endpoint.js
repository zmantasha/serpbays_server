#!/usr/bin/env node

/**
 * Test script to verify the Razorpay verify endpoint is working
 * 
 * Usage: node test-verify-endpoint.js <order_id> <payment_id> <signature>
 */

const axios = require('axios');

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const orderId = process.argv[2];
const paymentId = process.argv[3];
const signature = process.argv[4];

if (!orderId || !paymentId || !signature) {
  console.error('❌ Please provide order_id, payment_id, and signature');
  console.log('\nUsage: node test-verify-endpoint.js <order_id> <payment_id> <signature>');
  console.log('Example: node test-verify-endpoint.js order_RPKeiCHXnA5GJE pay_xxxxx signature_here\n');
  process.exit(1);
}

async function testVerifyEndpoint() {
  try {
    console.log(`\n🧪 Testing verify endpoint for order: ${orderId}\n`);

    const response = await axios.post(
      `${STRAPI_URL}/api/transactions/verify-razorpay`,
      {
        order_id: orderId,
        payment_id: paymentId,
        razorpay_signature: signature
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Verify endpoint response:');
    console.log(JSON.stringify(response.data, null, 2));

  } catch (error) {
    if (error.response) {
      console.error('❌ API Error:', error.response.status, error.response.statusText);
      console.error('Response:', error.response.data);
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

testVerifyEndpoint();

