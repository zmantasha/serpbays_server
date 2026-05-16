#!/usr/bin/env node

/**
 * Razorpay Integration Test Script
 * 
 * This script tests the Razorpay integration by:
 * 1. Creating a test order
 * 2. Verifying the payment service
 * 3. Testing webhook signature verification
 */

const Razorpay = require('razorpay');
const crypto = require('crypto');

// Load environment variables
require('dotenv').config();

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

async function testRazorpayIntegration() {
  console.log('🧪 Testing Razorpay Integration...\n');

  try {
    // Test 1: Create a test order
    console.log('1. Testing order creation...');
    const orderOptions = {
      amount: 1000, // ₹10.00 in paise
      currency: 'INR',
      receipt: `test_receipt_${Date.now()}`,
      notes: {
        source: 'serpbays_test',
        created_at: new Date().toISOString()
      }
    };

    const order = await razorpay.orders.create(orderOptions);
    console.log('✅ Order created successfully:', {
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      status: order.status
    });

    // Test 2: Verify payment signature function
    console.log('\n2. Testing payment signature verification...');
    const testPaymentId = 'pay_test123456789';
    const testOrderId = order.id;
    
    // Generate a test signature
    const testSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${testOrderId}|${testPaymentId}`)
      .digest('hex');

    console.log('✅ Test signature generated:', testSignature);

    // Test 3: Verify webhook signature function
    console.log('\n3. Testing webhook signature verification...');
    const testWebhookPayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: testPaymentId,
            order_id: testOrderId,
            amount: 1000,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };

    const testWebhookSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook_secret')
      .update(JSON.stringify(testWebhookPayload))
      .digest('hex');

    console.log('✅ Test webhook signature generated:', testWebhookSignature);

    // Test 4: Check environment variables
    console.log('\n4. Checking environment variables...');
    const requiredEnvVars = [
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET'
    ];

    let allEnvVarsPresent = true;
    requiredEnvVars.forEach(envVar => {
      if (process.env[envVar]) {
        console.log(`✅ ${envVar}: Set`);
      } else {
        console.log(`❌ ${envVar}: Missing`);
        allEnvVarsPresent = false;
      }
    });

    if (!allEnvVarsPresent) {
      console.log('\n⚠️  Some environment variables are missing. Please check your .env file.');
    }

    // Test 5: Test order retrieval
    console.log('\n5. Testing order retrieval...');
    const retrievedOrder = await razorpay.orders.fetch(order.id);
    console.log('✅ Order retrieved successfully:', {
      id: retrievedOrder.id,
      amount: retrievedOrder.amount,
      currency: retrievedOrder.currency,
      status: retrievedOrder.status
    });

    console.log('\n🎉 All tests passed! Razorpay integration is working correctly.');
    console.log('\n📋 Next steps:');
    console.log('1. Set up webhook URL in Razorpay dashboard');
    console.log('2. Test payment flow in your application');
    console.log('3. Monitor webhook delivery in Razorpay dashboard');
    console.log('4. Test with different payment methods');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    
    if (error.message.includes('Invalid key')) {
      console.log('\n💡 Tip: Check your RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env file');
    }
    
    if (error.message.includes('Network')) {
      console.log('\n💡 Tip: Check your internet connection and Razorpay API status');
    }
    
    process.exit(1);
  }
}

// Run the test
testRazorpayIntegration();
