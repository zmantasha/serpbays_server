#!/usr/bin/env node

/**
 * Email Webhook Test Script
 * 
 * Simulates incoming email webhooks from different providers
 * Run with: node scripts/test-email-webhook.js
 */

const axios = require('axios');

const BASE_URL = process.env.STRAPI_URL || 'http://localhost:1337';

console.log('📬 Testing Email Webhook Integration');
console.log('====================================');

// Simulate SendGrid webhook payload
const sendGridPayload = {
  to: 'orders@serpbays.com',
  from: 'publisher@example.com',
  subject: 'Order Response',
  text: 'I want to ACCEPT-123 this order. Thank you!',
  html: '<p>I want to ACCEPT-123 this order. Thank you!</p>'
};

// Simulate Mailgun webhook payload
const mailgunPayload = {
  recipient: 'orders@serpbays.com',
  sender: 'advertiser@example.com',
  subject: 'Payment Confirmation',
  'body-plain': 'CONFIRM-PAYMENT-456 - Please process my payment for order 456.',
  'body-html': '<p>CONFIRM-PAYMENT-456 - Please process my payment for order 456.</p>'
};

async function testSendGridWebhook() {
  try {
    console.log('\n1. Testing SendGrid webhook format...');
    console.log('   Simulating: Publisher accepting order #123');
    
    const response = await axios.post(`${BASE_URL}/api/email/webhook`, sendGridPayload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SendGrid-Webhook'
      }
    });
    
    console.log('✅ SendGrid webhook processed successfully');
    console.log('📋 Response:', response.data);
    
  } catch (error) {
    console.error('❌ SendGrid webhook test failed:', error.response?.data || error.message);
  }
}

async function testMailgunWebhook() {
  try {
    console.log('\n2. Testing Mailgun webhook format...');
    console.log('   Simulating: Advertiser confirming payment for order #456');
    
    const response = await axios.post(`${BASE_URL}/api/email/webhook`, mailgunPayload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mailgun-Webhook'
      }
    });
    
    console.log('✅ Mailgun webhook processed successfully');
    console.log('📋 Response:', response.data);
    
  } catch (error) {
    console.error('❌ Mailgun webhook test failed:', error.response?.data || error.message);
  }
}

async function testInvalidWebhook() {
  try {
    console.log('\n3. Testing invalid webhook format...');
    
    const invalidPayload = {
      invalid: 'payload',
      missing: 'required fields'
    };
    
    const response = await axios.post(`${BASE_URL}/api/email/webhook`, invalidPayload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log('⚠️  Invalid webhook was accepted (unexpected)');
    console.log('📋 Response:', response.data);
    
  } catch (error) {
    if (error.response?.status === 400) {
      console.log('✅ Invalid webhook correctly rejected');
    } else {
      console.error('❌ Unexpected error:', error.response?.data || error.message);
    }
  }
}

async function testEmailCommands() {
  console.log('\n4. Testing various email commands...');
  
  const commands = [
    {
      command: 'DELIVER-789',
      description: 'Publisher delivering order',
      from: 'publisher@example.com'
    },
    {
      command: 'DISPUTE-789',
      description: 'Advertiser disputing order',
      from: 'advertiser@example.com'
    },
    {
      command: 'INVALID-COMMAND',
      description: 'Invalid command format',
      from: 'user@example.com'
    }
  ];
  
  for (const test of commands) {
    try {
      console.log(`\n   Testing: ${test.description}`);
      
      const payload = {
        to: 'orders@serpbays.com',
        from: test.from,
        subject: 'Order Update',
        text: `Hello, I want to ${test.command}. Thanks!`,
        html: `<p>Hello, I want to ${test.command}. Thanks!</p>`
      };
      
      const response = await axios.post(`${BASE_URL}/api/email/webhook`, payload);
      console.log(`   ✅ Command "${test.command}" processed:`, response.data.result?.message || 'Success');
      
    } catch (error) {
      console.log(`   ❌ Command "${test.command}" failed:`, error.response?.data?.result?.message || error.message);
    }
  }
}

async function showWebhookSetup() {
  console.log('\n📋 Webhook Setup Instructions');
  console.log('==============================');
  
  console.log('\n🔧 SendGrid Setup:');
  console.log('1. Go to Settings > Mail Settings > Event Webhook');
  console.log('2. Add webhook URL: https://yourdomain.com/api/email/webhook');
  console.log('3. Select events: Inbound Parse');
  console.log('4. Enable webhook');
  
  console.log('\n🔧 Mailgun Setup:');
  console.log('1. Go to Receiving > Routes');
  console.log('2. Create route with expression: match_recipient(".*@yourdomain.com")');
  console.log('3. Action: forward("https://yourdomain.com/api/email/webhook")');
  console.log('4. Save route');
  
  console.log('\n🔧 DNS Setup (for both):');
  console.log('Add MX record: 10 mail.yourdomain.com');
  console.log('Add CNAME: mail.yourdomain.com -> your-provider-endpoint');
  
  console.log('\n📧 Test Email Address:');
  console.log('Send test emails to: orders@yourdomain.com');
  console.log('Include commands like: ACCEPT-123, REJECT-456, etc.');
}

// Main execution
async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.log('⚠️  Webhook testing should be done in development environment.');
    showWebhookSetup();
    return;
  }

  console.log(`🎯 Testing webhooks on: ${BASE_URL}`);
  
  await testSendGridWebhook();
  await testMailgunWebhook();
  await testInvalidWebhook();
  await testEmailCommands();
  
  console.log('\n🎉 Webhook testing completed!');
  console.log('\nNext steps:');
  console.log('1. Set up actual email provider webhooks');
  console.log('2. Configure your domain for email receiving');
  console.log('3. Test with real emails from your email client');
  
  showWebhookSetup();
}

// Run the script
main().catch(console.error);

module.exports = {
  testSendGridWebhook,
  testMailgunWebhook,
  testInvalidWebhook,
  testEmailCommands,
  showWebhookSetup
};
