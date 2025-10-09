/**
 * Test script for Payment Gateway Management
 * Run this script to test the payment gateway management functionality
 */

const axios = require('axios');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:1337';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'your-admin-token-here';

async function testPaymentGatewayManagement() {
  console.log('🧪 Testing Payment Gateway Management...\n');

  try {
    // Test 1: Get current payment gateway settings
    console.log('1️⃣ Testing GET /api/admin/payment-gateways');
    try {
      const getResponse = await axios.get(`${SERVER_URL}/api/admin/payment-gateways`, {
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('✅ GET payment gateways:', JSON.stringify(getResponse.data, null, 2));
    } catch (error) {
      console.log('❌ GET payment gateways failed:', error.response?.data || error.message);
    }

    // Test 2: Update payment gateway settings (disable Stripe)
    console.log('\n2️⃣ Testing PUT /api/admin/payment-gateways (disable Stripe)');
    try {
      const updateData = {
        paymentGateways: {
          stripe: {
            enabled: false,
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
        }
      };

      const updateResponse = await axios.put(`${SERVER_URL}/api/admin/payment-gateways`, updateData, {
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('✅ PUT payment gateways:', JSON.stringify(updateResponse.data, null, 2));
    } catch (error) {
      console.log('❌ PUT payment gateways failed:', error.response?.data || error.message);
    }

    // Test 3: Get enabled payment gateways (public endpoint)
    console.log('\n3️⃣ Testing GET /api/payment-gateways/enabled (public)');
    try {
      const enabledResponse = await axios.get(`${SERVER_URL}/api/payment-gateways/enabled`);
      console.log('✅ GET enabled payment gateways:', JSON.stringify(enabledResponse.data, null, 2));
    } catch (error) {
      console.log('❌ GET enabled payment gateways failed:', error.response?.data || error.message);
    }

    // Test 4: Re-enable Stripe
    console.log('\n4️⃣ Testing PUT /api/admin/payment-gateways (re-enable Stripe)');
    try {
      const reEnableData = {
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
        }
      };

      const reEnableResponse = await axios.put(`${SERVER_URL}/api/admin/payment-gateways`, reEnableData, {
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('✅ PUT payment gateways (re-enable):', JSON.stringify(reEnableResponse.data, null, 2));
    } catch (error) {
      console.log('❌ PUT payment gateways (re-enable) failed:', error.response?.data || error.message);
    }

    console.log('\n🎉 Payment Gateway Management tests completed!');
    console.log('\n📋 Next steps:');
    console.log('1. Start the admin panel: cd serpbays_admin && npm run dev');
    console.log('2. Navigate to /settings/payment-gateways');
    console.log('3. Test toggling payment gateways on/off');
    console.log('4. Check the client wallet page to see only enabled gateways');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
if (require.main === module) {
  testPaymentGatewayManagement();
}

module.exports = { testPaymentGatewayManagement };
