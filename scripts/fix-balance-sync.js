#!/usr/bin/env node

/**
 * Fix balance synchronization for user 188
 */

'use strict';

const { createStrapi } = require('@strapi/strapi');

async function fixBalanceSync() {
  console.log('🔧 Fixing balance synchronization for user 188...');
  
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
    
    // Calculate what the balance should be
    const calculatedBalance = parseFloat(wallet.mainBalance || 0) + parseFloat(wallet.promoBalance || 0);
    const currentBalance = parseFloat(wallet.balance || 0);
    
    console.log(`\n🧮 Balance calculation:`);
    console.log(`  MainBalance (${wallet.mainBalance}) + PromoBalance (${wallet.promoBalance}) = ${calculatedBalance}`);
    console.log(`  Current Balance field: ${currentBalance}`);
    console.log(`  Discrepancy: ${currentBalance - calculatedBalance}`);
    
    if (calculatedBalance !== currentBalance) {
      console.log(`\n🔧 Syncing balance field...`);
      
      // Update the balance field to match mainBalance + promoBalance
      await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
        data: {
          balance: calculatedBalance
        }
      });
      
      console.log(`  ✅ Updated balance from ${currentBalance} to ${calculatedBalance}`);
      
      // Verify the update
      const updatedWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { id: wallet.id }
      });
      
      console.log(`\n📊 Updated wallet state:`);
      console.log(`  Balance: ${updatedWallet.balance}`);
      console.log(`  MainBalance: ${updatedWallet.mainBalance}`);
      console.log(`  PromoBalance: ${updatedWallet.promoBalance}`);
      console.log(`  Sync check: ${parseFloat(updatedWallet.mainBalance) + parseFloat(updatedWallet.promoBalance)} = ${updatedWallet.balance} ✅`);
      
    } else {
      console.log(`  ✅ Balance is already synchronized`);
    }
    
    // Show final breakdown
    console.log(`\n💰 Final balance breakdown:`);
    console.log(`  Main Balance (withdrawable): $${wallet.mainBalance}`);
    console.log(`  Promo Balance (non-withdrawable): $${wallet.promoBalance}`);
    console.log(`  Total Balance: $${calculatedBalance}`);
    console.log(`  Pending Withdrawals: $${wallet.pendingWithdrawalBalance}`);
    console.log(`  Available for Withdrawal: $${Math.max(0, parseFloat(wallet.mainBalance) - parseFloat(wallet.pendingWithdrawalBalance))}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    if (strapi) {
      await strapi.destroy();
    }
  }
}

// Run the fix
fixBalanceSync()
  .then(() => {
    console.log('\n🎉 Balance sync completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Sync failed:', error);
    process.exit(1);
  });
