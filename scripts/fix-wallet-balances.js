#!/usr/bin/env node

/**
 * Fix wallet balances for separate balance tracking
 * This script migrates existing wallet data to the new separate balance system
 */

'use strict';

const { createStrapi } = require('@strapi/strapi');

async function fixWalletBalances() {
  console.log('🔧 Starting wallet balance migration...');
  
  let strapi;
  
  try {
    // Initialize Strapi
    strapi = await createStrapi();
    await strapi.load();
    
    console.log('✅ Strapi initialized');
    
    // Get all wallets
    const wallets = await strapi.db.query('api::user-wallet.user-wallet').findMany({
      populate: ['users_permissions_user']
    });
    
    console.log(`📊 Found ${wallets.length} wallets to migrate`);
    
    let migratedCount = 0;
    let errorCount = 0;
    
    for (const wallet of wallets) {
      try {
        console.log(`\n🔍 Processing wallet ${wallet.id} for user ${wallet.users_permissions_user?.id || 'unknown'}`);
        
        // Check if wallet already has separate balance fields
        if (wallet.mainBalance !== undefined && wallet.promoBalance !== undefined) {
          console.log(`  ⏭️  Wallet ${wallet.id} already migrated, skipping`);
          continue;
        }
        
        const currentBalance = parseFloat(wallet.balance || 0);
        const currentEscrow = parseFloat(wallet.escrowBalance || 0);
        const currentPending = parseFloat(wallet.pendingWithdrawalBalance || 0);
        
        console.log(`  📋 Current state: Balance=${currentBalance}, Escrow=${currentEscrow}, Pending=${currentPending}`);
        
        // For existing wallets, assume all current balance is main balance
        // (since promo tracking wasn't implemented before)
        const mainBalance = currentBalance;
        const promoBalance = 0; // Start with 0 promo balance
        
        console.log(`  🔄 Migrating to: MainBalance=${mainBalance}, PromoBalance=${promoBalance}`);
        
        // Update wallet with new balance structure
        await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
          data: {
            mainBalance: mainBalance,
            promoBalance: promoBalance,
            // Keep existing balance as total
            balance: mainBalance + promoBalance
          }
        });
        
        console.log(`  ✅ Wallet ${wallet.id} migrated successfully`);
        migratedCount++;
        
      } catch (error) {
        console.error(`  ❌ Error migrating wallet ${wallet.id}:`, error.message);
        errorCount++;
      }
    }
    
    console.log(`\n🎉 Migration completed!`);
    console.log(`  ✅ Migrated: ${migratedCount} wallets`);
    console.log(`  ❌ Errors: ${errorCount} wallets`);
    
    // Also update existing transactions with fund_source
    console.log(`\n🔄 Updating transaction fund sources...`);
    
    const transactions = await strapi.db.query('api::transaction.transaction').findMany();
    console.log(`📊 Found ${transactions.length} transactions to update`);
    
    let transactionUpdated = 0;
    
    for (const transaction of transactions) {
      try {
        let fundSource = null;
        
        // Determine fund source based on gateway and type
        if (transaction.gateway === 'promo') {
          fundSource = 'promo_fund';
        } else if (['stripe', 'paypal', 'razorpay', 'system'].includes(transaction.gateway)) {
          if (['deposit', 'escrow_release', 'refund'].includes(transaction.type)) {
            fundSource = 'main_fund';
          } else if (transaction.type === 'payment') {
            // For payments, we need to determine based on spending logic
            // Since we can't retroactively determine this, we'll mark as main_fund
            fundSource = 'main_fund';
          } else {
            fundSource = 'main_fund';
          }
        }
        
        if (fundSource) {
          await strapi.entityService.update('api::transaction.transaction', transaction.id, {
            data: {
              fund_source: fundSource
            }
          });
          transactionUpdated++;
        }
        
      } catch (error) {
        console.error(`  ❌ Error updating transaction ${transaction.id}:`, error.message);
      }
    }
    
    console.log(`  ✅ Updated ${transactionUpdated} transactions with fund sources`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    if (strapi) {
      await strapi.destroy();
    }
  }
}

// Run the migration
fixWalletBalances()
  .then(() => {
    console.log('\n🎉 Wallet balance migration completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  });
