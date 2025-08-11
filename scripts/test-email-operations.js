#!/usr/bin/env node

/**
 * Email Operations Test Script
 * 
 * This script demonstrates and tests the email operations system.
 * Run with: node scripts/test-email-operations.js
 */

const axios = require('axios');

// Configuration
const BASE_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';

console.log('🧪 Testing Email Operations System');
console.log('=====================================');

async function testEmailOperations() {
  try {
    console.log('\n1. Testing Payment Required Email...');
    const paymentTest = await axios.post(`${BASE_URL}/api/email/test`, {
      type: 'payment_required',
      email: TEST_EMAIL,
      orderId: 123
    });
    console.log('✅ Payment email sent successfully');

    console.log('\n2. Testing Order Creation Email...');
    const orderTest = await axios.post(`${BASE_URL}/api/email/test`, {
      type: 'order_creation',
      email: TEST_EMAIL,
      orderId: 123
    });
    console.log('✅ Order creation email sent successfully');

    console.log('\n3. Testing Transaction Approval Email...');
    const transactionTest = await axios.post(`${BASE_URL}/api/email/test`, {
      type: 'transaction_approval',
      email: TEST_EMAIL,
      transactionId: 456
    });
    console.log('✅ Transaction approval email sent successfully');

    console.log('\n4. Testing Email Command Processing...');
    const commandTest = await axios.post(`${BASE_URL}/api/email/process-command`, {
      command: 'ACCEPT',
      entityId: 123,
      userEmail: TEST_EMAIL
    });
    console.log('✅ Email command processed:', commandTest.data);

    console.log('\n🎉 All tests completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Check your email inbox for test emails');
    console.log('2. Set up email webhooks with your provider');
    console.log('3. Configure your email reply-to address');
    console.log('4. Test with real orders and transactions');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('\n💡 Make sure Strapi is running on', BASE_URL);
    }
    
    if (error.response?.status === 403) {
      console.log('\n💡 This is expected in production. Tests are disabled for security.');
    }
  }
}

async function testEmailCommands() {
  console.log('\n📧 Testing Email Command Examples');
  console.log('==================================');

  const commands = [
    { command: 'CONFIRM-PAYMENT', entityId: 123, description: 'Confirm payment for order' },
    { command: 'ACCEPT', entityId: 123, description: 'Accept an order' },
    { command: 'REJECT', entityId: 123, description: 'Reject an order' },
    { command: 'DELIVER', entityId: 123, description: 'Mark order as delivered' },
    { command: 'APPROVE', entityId: 123, description: 'Approve/complete an order' },
    { command: 'DISPUTE', entityId: 123, description: 'Dispute an order' }
  ];

  console.log('\nSupported email commands:');
  commands.forEach(cmd => {
    console.log(`📬 ${cmd.command}-${cmd.entityId} : ${cmd.description}`);
  });

  console.log('\nEmail command format:');
  console.log('- Commands are case-insensitive');
  console.log('- Include entity ID after hyphen');
  console.log('- Can be anywhere in email body');
  console.log('- Example: "I want to ACCEPT-123 this order"');
}

async function showEndpoints() {
  console.log('\n🔗 Available API Endpoints');
  console.log('==========================');

  const endpoints = [
    { method: 'POST', path: '/api/email/webhook', auth: false, description: 'Email webhook (for providers)' },
    { method: 'POST', path: '/api/email/process-command', auth: true, description: 'Manual command processing' },
    { method: 'POST', path: '/api/email/trigger-order-operation', auth: true, description: 'Trigger order emails' },
    { method: 'POST', path: '/api/email/trigger-transaction-operation', auth: true, description: 'Trigger transaction emails' },
    { method: 'GET', path: '/api/email/stats', auth: true, description: 'Email statistics (admin)' },
    { method: 'POST', path: '/api/email/test', auth: false, description: 'Test emails (dev only)' },
    { method: 'PUT', path: '/api/transactions/:id/approve', auth: true, description: 'Approve transaction (admin)' },
    { method: 'PUT', path: '/api/transactions/:id/deny', auth: true, description: 'Deny transaction (admin)' },
    { method: 'PUT', path: '/api/transactions/:id/mark-paid', auth: true, description: 'Mark as paid (admin)' }
  ];

  endpoints.forEach(endpoint => {
    const authIcon = endpoint.auth ? '🔒' : '🔓';
    console.log(`${authIcon} ${endpoint.method.padEnd(4)} ${endpoint.path.padEnd(40)} - ${endpoint.description}`);
  });
}

// Main execution
async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.log('⚠️  This script is for development/testing only.');
    console.log('Email operations are integrated and ready for production use.');
    return;
  }

  await testEmailCommands();
  await showEndpoints();
  
  console.log('\n🚀 Starting email tests...');
  await testEmailOperations();
}

// Run the script
main().catch(console.error);

module.exports = {
  testEmailOperations,
  testEmailCommands,
  showEndpoints
};
