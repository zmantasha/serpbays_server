#!/usr/bin/env node

/**
 * Test script to verify if Razorpay webhooks are updating transaction status
 * 
 * Usage: node test-webhook-status.js <gatewayTransactionId>
 * Example: node test-webhook-status.js order_RPKeiCHXnA5GJE
 */

const axios = require('axios');

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const gatewayTransactionId = process.argv[2];

if (!gatewayTransactionId) {
  console.error('❌ Please provide a gatewayTransactionId (order ID)');
  console.log('\nUsage: node test-webhook-status.js <gatewayTransactionId>');
  console.log('Example: node test-webhook-status.js order_RPKeiCHXnA5GJE\n');
  process.exit(1);
}

async function checkTransactionStatus() {
  try {
    console.log(`\n🔍 Checking transaction status for: ${gatewayTransactionId}\n`);

    // Get the transaction from database
    const response = await axios.get(
      `${STRAPI_URL}/api/transactions?filters[gatewayTransactionId][$eq]=${gatewayTransactionId}&populate=user_wallet`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.STRAPI_API_TOKEN || ''}`
        }
      }
    );

    if (response.data.data && response.data.data.length > 0) {
      const transaction = response.data.data[0];
      console.log('📋 Transaction Details:');
      console.log('─────────────────────────────────────');
      console.log(`ID: ${transaction.id}`);
      console.log(`Gateway Transaction ID: ${transaction.attributes.gatewayTransactionId}`);
      console.log(`Status: ${transaction.attributes.transactionStatus}`);
      console.log(`Amount: ${transaction.attributes.amount} ${transaction.attributes.currency}`);
      console.log(`Type: ${transaction.attributes.type}`);
      console.log(`Gateway: ${transaction.attributes.gateway}`);
      console.log(`Created At: ${transaction.attributes.createdAt}`);
      console.log(`Updated At: ${transaction.attributes.updatedAt}`);
      
      if (transaction.attributes.external_transaction_id) {
        console.log(`External Transaction ID: ${transaction.attributes.external_transaction_id}`);
      }
      
      if (transaction.attributes.metadata) {
        console.log(`\nMetadata: ${JSON.stringify(transaction.attributes.metadata, null, 2)}`);
      }
      
      console.log('─────────────────────────────────────\n');

      // Status interpretation
      if (transaction.attributes.transactionStatus === 'success') {
        console.log('✅ Transaction is SUCCESSFUL - Webhook has updated the status!');
        console.log('💰 Wallet balance should have been updated.');
      } else if (transaction.attributes.transactionStatus === 'pending') {
        console.log('⏳ Transaction is still PENDING');
        console.log('\n💡 Possible reasons:');
        console.log('   1. Webhook has not been triggered yet by Razorpay');
        console.log('   2. Payment is still in progress');
        console.log('   3. Webhook URL might not be receiving requests');
        console.log('   4. Check Razorpay Dashboard > Webhooks > Logs for delivery status');
      } else if (transaction.attributes.transactionStatus === 'failed') {
        console.log('❌ Transaction FAILED');
      }

    } else {
      console.log('❌ No transaction found with gatewayTransactionId:', gatewayTransactionId);
      console.log('\n💡 Tips:');
      console.log('   - Verify the order ID is correct');
      console.log('   - Check if transaction was created in Strapi');
    }

  } catch (error) {
    if (error.response) {
      console.error('❌ API Error:', error.response.status, error.response.statusText);
      if (error.response.status === 403) {
        console.log('\n💡 Tip: You might need to set STRAPI_API_TOKEN in .env for authenticated access');
      }
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

checkTransactionStatus();

