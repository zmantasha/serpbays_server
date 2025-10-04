#!/usr/bin/env node

/**
 * Script to fix pending Razorpay transactions that should be successful
 * 
 * This script will:
 * 1. Find all pending Razorpay transactions
 * 2. Check their status with Razorpay API
 * 3. Update successful ones to 'success' status
 * 4. Update wallet balances accordingly
 * 
 * Usage: node fix-pending-razorpay-transactions.js
 */

const axios = require('axios');
const Razorpay = require('razorpay');

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337';

async function fixPendingTransactions() {
  try {
    console.log('🔍 Finding pending Razorpay transactions...\n');

    // Get all pending Razorpay transactions
    const response = await axios.get(
      `${STRAPI_URL}/api/transactions?filters[gateway][$eq]=razorpay&filters[transactionStatus][$eq]=pending&populate=user_wallet`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.STRAPI_API_TOKEN || ''}`
        }
      }
    );

    const transactions = response.data.data || [];
    
    if (transactions.length === 0) {
      console.log('✅ No pending Razorpay transactions found!');
      return;
    }

    console.log(`📋 Found ${transactions.length} pending Razorpay transactions:\n`);

    let fixedCount = 0;
    let errorCount = 0;

    for (const transaction of transactions) {
      const orderId = transaction.attributes.gatewayTransactionId;
      const transactionId = transaction.id;
      const amount = transaction.attributes.amount;
      const currency = transaction.attributes.currency;
      const walletId = transaction.attributes.user_wallet?.id;

      console.log(`🔍 Checking order: ${orderId} (Transaction ID: ${transactionId})`);

      try {
        // Check order status with Razorpay
        const order = await razorpay.orders.fetch(orderId);
        
        if (order.status === 'paid') {
          console.log(`✅ Order ${orderId} is paid - updating transaction status`);
          
          // Get payment details
          const payments = await razorpay.orders.fetchPayments(orderId);
          const payment = payments.items[0]; // Get the first payment
          
          if (payment && payment.status === 'captured') {
            // Update transaction status
            await axios.put(
              `${STRAPI_URL}/api/transactions/${transactionId}`,
              {
                data: {
                  transactionStatus: 'success',
                  external_transaction_id: payment.id,
                  updatedAt: new Date().toISOString()
                }
              },
              {
                headers: {
                  'Authorization': `Bearer ${process.env.STRAPI_API_TOKEN || ''}`,
                  'Content-Type': 'application/json'
                }
              }
            );

            // Update wallet balance if wallet exists
            if (walletId) {
              const walletResponse = await axios.get(
                `${STRAPI_URL}/api/user-wallets/${walletId}`,
                {
                  headers: {
                    'Authorization': `Bearer ${process.env.STRAPI_API_TOKEN || ''}`
                  }
                }
              );

              const wallet = walletResponse.data.data;
              const newMainBalance = parseFloat(wallet.attributes.mainBalance) + amount;
              const newBalance = parseFloat(wallet.attributes.balance) + amount;

              await axios.put(
                `${STRAPI_URL}/api/user-wallets/${walletId}`,
                {
                  data: {
                    mainBalance: newMainBalance,
                    balance: newBalance,
                    updatedAt: new Date().toISOString()
                  }
                },
                {
                  headers: {
                    'Authorization': `Bearer ${process.env.STRAPI_API_TOKEN || ''}`,
                    'Content-Type': 'application/json'
                  }
                }
              );

              console.log(`💰 Updated wallet ${walletId} balance: +${amount} ${currency}`);
            }

            console.log(`✅ Successfully updated transaction ${transactionId} to success status\n`);
            fixedCount++;
          } else {
            console.log(`⚠️  Order ${orderId} is paid but payment not captured yet\n`);
          }
        } else {
          console.log(`⏳ Order ${orderId} status: ${order.status} - keeping as pending\n`);
        }

      } catch (error) {
        console.error(`❌ Error checking order ${orderId}:`, error.message);
        errorCount++;
      }
    }

    console.log('📊 Summary:');
    console.log(`✅ Fixed: ${fixedCount} transactions`);
    console.log(`❌ Errors: ${errorCount} transactions`);
    console.log(`⏳ Remaining pending: ${transactions.length - fixedCount - errorCount} transactions`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

// Run the script
fixPendingTransactions();
