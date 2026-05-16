#!/usr/bin/env node

/**
 * Check and fix wallet for user 188
 */

'use strict';

const { createStrapi } = require('@strapi/strapi');

async function checkUser188Wallet() {
  console.log('🔍 Checking wallet for user 188...');
  
  let strapi;
  
  try {
    // Initialize Strapi
    strapi = await createStrapi();
    await strapi.load();
    
    console.log('✅ Strapi initialized');
    
    // Get user 188's wallet
    const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: { users_permissions_user: 188 },
      populate: ['users_permissions_user']
    });
    
    if (!wallet) {
      console.log('❌ No wallet found for user 188');
      return;
    }
    
    console.log('\n📊 Current wallet state:');
    console.log(`  ID: ${wallet.id}`);
    console.log(`  User: ${wallet.users_permissions_user?.id || 'unknown'}`);
    console.log(`  Balance: ${wallet.balance}`);
    console.log(`  MainBalance: ${wallet.mainBalance}`);
    console.log(`  PromoBalance: ${wallet.promoBalance}`);
    console.log(`  EscrowBalance: ${wallet.escrowBalance}`);
    console.log(`  PendingWithdrawalBalance: ${wallet.pendingWithdrawalBalance}`);
    
    // Check if mainBalance + promoBalance = balance
    const expectedBalance = parseFloat(wallet.mainBalance || 0) + parseFloat(wallet.promoBalance || 0);
    const actualBalance = parseFloat(wallet.balance || 0);
    
    console.log(`\n🧮 Balance calculation:`);
    console.log(`  MainBalance (${wallet.mainBalance}) + PromoBalance (${wallet.promoBalance}) = ${expectedBalance}`);
    console.log(`  Actual Balance: ${actualBalance}`);
    console.log(`  Match: ${expectedBalance === actualBalance ? '✅' : '❌'}`);
    
    if (expectedBalance !== actualBalance) {
      console.log(`\n🔧 Fixing balance calculation...`);
      
      // Fix the balance to match mainBalance + promoBalance
      await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
        data: {
          balance: expectedBalance
        }
      });
      
      console.log(`  ✅ Updated balance from ${actualBalance} to ${expectedBalance}`);
    }
    
    // Check transactions for this user
    console.log(`\n📋 Recent transactions for user 188:`);
    const transactions = await strapi.db.query('api::transaction.transaction').findMany({
      where: { users_permissions_user: 188 },
      orderBy: { createdAt: 'DESC' },
      limit: 10
    });
    
    transactions.forEach((tx, index) => {
      console.log(`  ${index + 1}. ${tx.type} - $${tx.amount} (${tx.gateway}) - ${tx.fund_source || 'unknown source'} - ${new Date(tx.createdAt).toLocaleDateString()}`);
    });
    
    // Check withdrawal requests
    console.log(`\n💸 Recent withdrawal requests:`);
    const withdrawals = await strapi.db.query('api::withdrawal-request.withdrawal-request').findMany({
      where: { publisher: 188 },
      orderBy: { createdAt: 'DESC' },
      limit: 5
    });
    
    withdrawals.forEach((w, index) => {
      console.log(`  ${index + 1}. $${w.amount} (${w.method}) - Status: ${w.withdrawal_status} - ${new Date(w.createdAt).toLocaleDateString()}`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    if (strapi) {
      await strapi.destroy();
    }
  }
}

// Run the check
checkUser188Wallet()
  .then(() => {
    console.log('\n🎉 Wallet check completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Check failed:', error);
    process.exit(1);
  });
