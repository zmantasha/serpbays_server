#!/usr/bin/env node

/**
 * Direct fix for user 189's promo balance
 */

'use strict';

const { createStrapi } = require('@strapi/strapi');

async function fixUser189Direct() {
  console.log('🔧 Direct fix for user 189...');
  
  let strapi;
  
  try {
    // Initialize Strapi
    strapi = await createStrapi();
    await strapi.load();
    
    console.log('✅ Strapi initialized');
    
    // Get user 189's wallet
    const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: { users_permissions_user: 189 }
    });
    
    if (!wallet) {
      console.log('❌ No wallet found for user 189');
      return;
    }
    
    console.log('\n📊 Current wallet state:');
    console.log(`  Balance: ${wallet.balance}`);
    console.log(`  MainBalance: ${wallet.mainBalance}`);
    console.log(`  PromoBalance: ${wallet.promoBalance}`);
    console.log(`  EscrowBalance: ${wallet.escrowBalance}`);
    console.log(`  PendingWithdrawalBalance: ${wallet.pendingWithdrawalBalance}`);
    
    // Based on the transaction history we saw:
    // 1. Promo: +$100 (should be in promo balance)
    // 2. Deposit: +$64 (should be in main balance)
    // 3. Withdrawal: -$34 (should be deducted from main balance, but moved to pending)
    
    // So the correct balances should be:
    const correctMainBalance = 64 - 34; // $64 deposit - $34 withdrawal = $30
    const correctPromoBalance = 100; // $100 from promo
    const correctTotalBalance = correctMainBalance + correctPromoBalance; // $130
    
    console.log('\n🧮 Expected balances based on transaction history:');
    console.log(`  MainBalance: $${correctMainBalance} (deposit $64 - withdrawal $34)`);
    console.log(`  PromoBalance: $${correctPromoBalance} (promo $100)`);
    console.log(`  TotalBalance: $${correctTotalBalance}`);
    
    // But we need to account for pending withdrawals
    // The $34 withdrawal is pending, so:
    const currentMainBalance = 64; // The $64 deposit
    const currentPromoBalance = 100; // The $100 promo
    const currentTotalBalance = currentMainBalance + currentPromoBalance; // $164
    
    console.log('\n🔧 Correcting balances (accounting for pending withdrawal):');
    console.log(`  MainBalance: $${currentMainBalance} (before pending withdrawal)`);
    console.log(`  PromoBalance: $${currentPromoBalance} (unchanged)`);
    console.log(`  TotalBalance: $${currentTotalBalance}`);
    console.log(`  PendingWithdrawal: $${wallet.pendingWithdrawalBalance} (already set)`);
    
    // Update wallet with correct balances
    await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
      data: {
        mainBalance: currentMainBalance,
        promoBalance: currentPromoBalance,
        balance: currentTotalBalance
      }
    });
    
    console.log('\n✅ Wallet updated successfully!');
    
    // Verify the update
    const updatedWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: { id: wallet.id }
    });
    
    console.log('\n📊 Updated wallet state:');
    console.log(`  Balance: ${updatedWallet.balance}`);
    console.log(`  MainBalance: ${updatedWallet.mainBalance}`);
    console.log(`  PromoBalance: ${updatedWallet.promoBalance}`);
    console.log(`  EscrowBalance: ${updatedWallet.escrowBalance}`);
    console.log(`  PendingWithdrawalBalance: ${updatedWallet.pendingWithdrawalBalance}`);
    
    // Show final breakdown
    const availableForWithdrawal = Math.max(0, parseFloat(updatedWallet.mainBalance) - parseFloat(updatedWallet.pendingWithdrawalBalance));
    
    console.log('\n💰 Final balance breakdown:');
    console.log(`  Main Balance (withdrawable): $${updatedWallet.mainBalance}`);
    console.log(`  Promo Balance (non-withdrawable): $${updatedWallet.promoBalance}`);
    console.log(`  Total Balance: $${updatedWallet.balance}`);
    console.log(`  Pending Withdrawals: $${updatedWallet.pendingWithdrawalBalance}`);
    console.log(`  Available for Withdrawal: $${availableForWithdrawal}`);
    
    console.log('\n🎉 User 189 balance fix completed!');
    console.log('Now refresh your dashboard to see the correct balances.');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    if (strapi) {
      await strapi.destroy();
    }
  }
}

// Run the fix
fixUser189Direct()
  .then(() => {
    console.log('\n🎉 Direct fix completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Fix failed:', error);
    process.exit(1);
  });
