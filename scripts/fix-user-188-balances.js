#!/usr/bin/env node

/**
 * Fix balances for user 188 based on transaction history
 */

'use strict';

const { createStrapi } = require('@strapi/strapi');

async function fixUser188Balances() {
  console.log('🔧 Fixing balances for user 188...');
  
  let strapi;
  
  try {
    // Initialize Strapi
    strapi = await createStrapi();
    await strapi.load();
    
    console.log('✅ Strapi initialized');
    
    // Get user 188's wallet
    const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: { users_permissions_user: 188 }
    });
    
    if (!wallet) {
      console.log('❌ No wallet found for user 188');
      return;
    }
    
    console.log('\n📊 Current wallet state:');
    console.log(`  Balance: ${wallet.balance}`);
    console.log(`  MainBalance: ${wallet.mainBalance}`);
    console.log(`  PromoBalance: ${wallet.promoBalance}`);
    console.log(`  EscrowBalance: ${wallet.escrowBalance}`);
    console.log(`  PendingWithdrawalBalance: ${wallet.pendingWithdrawalBalance}`);
    
    // Get all transactions for user 188
    const transactions = await strapi.db.query('api::transaction.transaction').findMany({
      where: { users_permissions_user: 188 },
      orderBy: { createdAt: 'ASC' }
    });
    
    console.log('\n📋 All transactions for user 188:');
    let calculatedMainBalance = 0;
    let calculatedPromoBalance = 0;
    
    transactions.forEach((tx, index) => {
      const amount = parseFloat(tx.amount || 0);
      const fundSource = tx.fund_source;
      
      console.log(`  ${index + 1}. ${tx.type} - $${amount} (${tx.gateway}) - Source: ${fundSource} - ${new Date(tx.createdAt).toLocaleDateString()}`);
      
      // Calculate balances based on transaction type and fund source
      if (tx.type === 'deposit' && fundSource === 'main_fund') {
        calculatedMainBalance += amount;
      } else if (tx.type === 'promo' && fundSource === 'promo_fund') {
        calculatedPromoBalance += amount;
      } else if (tx.type === 'payment' && fundSource === 'main_fund') {
        calculatedMainBalance -= amount;
      } else if (tx.type === 'payment' && fundSource === 'promo_fund') {
        calculatedPromoBalance -= amount;
      } else if (tx.type === 'withdrawal' && fundSource === 'main_fund') {
        calculatedMainBalance -= amount;
      } else if (tx.type === 'escrow_release' && fundSource === 'main_fund') {
        calculatedMainBalance += amount;
      }
    });
    
    console.log('\n🧮 Calculated balances from transactions:');
    console.log(`  MainBalance: $${calculatedMainBalance}`);
    console.log(`  PromoBalance: $${calculatedPromoBalance}`);
    console.log(`  Total: $${calculatedMainBalance + calculatedPromoBalance}`);
    
    // Update wallet with correct balances
    const newTotalBalance = calculatedMainBalance + calculatedPromoBalance;
    
    console.log('\n🔧 Updating wallet balances...');
    await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
      data: {
        mainBalance: calculatedMainBalance,
        promoBalance: calculatedPromoBalance,
        balance: newTotalBalance
      }
    });
    
    console.log('✅ Wallet updated successfully!');
    console.log(`  New MainBalance: $${calculatedMainBalance}`);
    console.log(`  New PromoBalance: $${calculatedPromoBalance}`);
    console.log(`  New Total Balance: $${newTotalBalance}`);
    console.log(`  Pending Withdrawal: $${wallet.pendingWithdrawalBalance}`);
    
    // Calculate available balance for withdrawal
    const availableForWithdrawal = Math.max(0, calculatedMainBalance - parseFloat(wallet.pendingWithdrawalBalance || 0));
    console.log(`  Available for withdrawal: $${availableForWithdrawal}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    if (strapi) {
      await strapi.destroy();
    }
  }
}

// Run the fix
fixUser188Balances()
  .then(() => {
    console.log('\n🎉 Balance fix completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Fix failed:', error);
    process.exit(1);
  });
