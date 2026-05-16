#!/usr/bin/env node

/**
 * Direct database check for transaction status
 * This script connects directly to Strapi's database to check transaction status
 * 
 * Usage: node check-transaction-status.js <gatewayTransactionId>
 * Example: node check-transaction-status.js order_RPKeiCHXnA5GJE
 */

const gatewayTransactionId = process.argv[2];

if (!gatewayTransactionId) {
  console.error('❌ Please provide a gatewayTransactionId (order ID)');
  console.log('\nUsage: node check-transaction-status.js <gatewayTransactionId>');
  console.log('Example: node check-transaction-status.js order_RPKeiCHXnA5GJE\n');
  process.exit(1);
}

async function checkTransactionStatus() {
  let strapi;
  
  try {
    console.log(`\n🔍 Checking transaction status for: ${gatewayTransactionId}\n`);
    console.log('🔌 Connecting to Strapi...');

    // Bootstrap Strapi
    const Strapi = require('@strapi/strapi');
    strapi = await Strapi.default().load();

    console.log('✅ Connected to Strapi database\n');

    // Query the transaction
    const transaction = await strapi.db.query('api::transaction.transaction').findOne({
      where: { gatewayTransactionId: gatewayTransactionId },
      populate: ['user_wallet', 'users_permissions_user']
    });

    if (transaction) {
      console.log('📋 Transaction Found:');
      console.log('═════════════════════════════════════════════════════════════');
      console.log(`Transaction ID:           ${transaction.id}`);
      console.log(`Gateway Transaction ID:   ${transaction.gatewayTransactionId}`);
      console.log(`Status:                   ${transaction.transactionStatus}`);
      console.log(`Type:                     ${transaction.type}`);
      console.log(`Amount:                   ${transaction.amount} ${transaction.currency || 'USD'}`);
      console.log(`Gateway:                  ${transaction.gateway}`);
      console.log(`Created At:               ${transaction.createdAt}`);
      console.log(`Updated At:               ${transaction.updatedAt}`);
      
      if (transaction.external_transaction_id) {
        console.log(`External Transaction ID:  ${transaction.external_transaction_id}`);
      }
      
      if (transaction.payment_notes) {
        console.log(`Payment Notes:            ${transaction.payment_notes}`);
      }

      if (transaction.user_wallet) {
        console.log(`\n💰 Wallet Information:`);
        console.log(`Wallet ID:                ${transaction.user_wallet.id}`);
        console.log(`Main Balance:             ${transaction.user_wallet.mainBalance || 0}`);
        console.log(`Promo Balance:            ${transaction.user_wallet.promoBalance || 0}`);
        console.log(`Total Balance:            ${transaction.user_wallet.balance || 0}`);
        console.log(`Currency:                 ${transaction.user_wallet.currency || 'USD'}`);
      }

      if (transaction.users_permissions_user) {
        console.log(`\n👤 User Information:`);
        console.log(`User ID:                  ${transaction.users_permissions_user.id}`);
        console.log(`Username:                 ${transaction.users_permissions_user.username}`);
        console.log(`Email:                    ${transaction.users_permissions_user.email}`);
      }
      
      if (transaction.metadata) {
        console.log(`\n📝 Metadata:`);
        console.log(JSON.stringify(transaction.metadata, null, 2));
      }
      
      console.log('═════════════════════════════════════════════════════════════\n');

      // Status interpretation
      if (transaction.transactionStatus === 'success') {
        console.log('✅ Transaction Status: SUCCESS');
        console.log('   ↳ Webhook has successfully updated the status!');
        console.log('   ↳ Wallet balance has been updated.');
        console.log('   ↳ Payment was captured by Razorpay.');
      } else if (transaction.transactionStatus === 'pending') {
        console.log('⏳ Transaction Status: PENDING');
        console.log('\n💡 Possible reasons:');
        console.log('   1. Webhook has not been triggered yet by Razorpay');
        console.log('   2. Payment is still being processed');
        console.log('   3. Webhook URL might not be receiving requests');
        console.log('   4. Webhook signature verification might be failing');
        console.log('\n🔍 Next Steps:');
        console.log('   → Check Razorpay Dashboard > Webhooks > Logs');
        console.log('   → Verify webhook URL is publicly accessible');
        console.log('   → Check server logs for webhook errors:');
        console.log('      grep -i "razorpay.*webhook" server.log');
        console.log('   → Verify RAZORPAY_WEBHOOK_SECRET is set correctly');
      } else if (transaction.transactionStatus === 'failed') {
        console.log('❌ Transaction Status: FAILED');
        console.log('   ↳ Payment failed or was rejected.');
        if (transaction.payment_notes) {
          console.log(`   ↳ Reason: ${transaction.payment_notes}`);
        }
      } else {
        console.log(`ℹ️  Transaction Status: ${transaction.transactionStatus.toUpperCase()}`);
      }

      // Check if webhook has updated
      const timeDiff = new Date(transaction.updatedAt) - new Date(transaction.createdAt);
      const secondsDiff = Math.floor(timeDiff / 1000);
      
      if (secondsDiff > 0) {
        console.log(`\n⏱️  Time between creation and last update: ${secondsDiff} seconds`);
        if (transaction.transactionStatus === 'success') {
          console.log('   ↳ Webhook updated the transaction successfully!');
        }
      } else {
        console.log('\n⚠️  Transaction has not been updated since creation');
        console.log('   ↳ Webhook may not have fired yet');
      }

    } else {
      console.log('❌ No transaction found with gatewayTransactionId:', gatewayTransactionId);
      console.log('\n💡 Troubleshooting:');
      console.log('   - Verify the order ID is correct (should start with "order_")');
      console.log('   - Check if transaction was created in Strapi');
      console.log('   - Try searching in Strapi Admin Panel > Content Manager > Transactions');
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('\n💡 Tip: Make sure your database is running');
    }
    
    if (error.message.includes('relation') || error.message.includes('table')) {
      console.log('\n💡 Tip: Make sure your Strapi database migrations are up to date');
    }
  } finally {
    // Cleanup and exit
    if (strapi) {
      await strapi.destroy();
    }
    process.exit(0);
  }
}

checkTransactionStatus();

