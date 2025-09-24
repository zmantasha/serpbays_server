#!/usr/bin/env node

/**
 * Fix promo transactions that don't have fund_source set
 */

'use strict';

const { createStrapi } = require('@strapi/strapi');

async function fixPromoTransactions() {
  console.log('🔧 Fixing promo transactions...');
  
  let strapi;
  
  try {
    // Initialize Strapi
    strapi = await createStrapi();
    await strapi.load();
    
    console.log('✅ Strapi initialized');
    
    // Find all promo transactions that don't have fund_source set
    const promoTransactions = await strapi.db.query('api::transaction.transaction').findMany({
      where: {
        type: 'promo',
        fund_source: null
      }
    });
    
    console.log(`📊 Found ${promoTransactions.length} promo transactions without fund_source`);
    
    let fixedCount = 0;
    
    for (const tx of promoTransactions) {
      console.log(`\n🔍 Processing transaction ${tx.id}:`);
      console.log(`  Amount: $${tx.amount}`);
      console.log(`  Gateway: ${tx.gateway}`);
      console.log(`  User: ${tx.users_permissions_user}`);
      console.log(`  Current fund_source: ${tx.fund_source}`);
      
      // Update the transaction to set fund_source as promo_fund
      await strapi.entityService.update('api::transaction.transaction', tx.id, {
        data: {
          fund_source: 'promo_fund'
        }
      });
      
      console.log(`  ✅ Updated fund_source to: promo_fund`);
      fixedCount++;
    }
    
    console.log(`\n🎉 Fixed ${fixedCount} promo transactions`);
    
    // Now recalculate balances for all users with promo transactions
    console.log('\n🔄 Recalculating balances for affected users...');
    
    const allPromoTransactions = await strapi.db.query('api::transaction.transaction').findMany({
      where: {
        type: 'promo'
      }
    });
    
    const affectedUserIds = [...new Set(allPromoTransactions.map(tx => tx.users_permissions_user))];
    console.log(`📊 Found ${affectedUserIds.length} users with promo transactions`);
    
    for (const userId of affectedUserIds) {
      console.log(`\n👤 Recalculating balance for user ${userId}:`);
      
      // Get user's wallet
      const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });
      
      if (!wallet) {
        console.log(`  ❌ No wallet found for user ${userId}`);
        continue;
      }
      
      // Get all transactions for this user
      const userTransactions = await strapi.db.query('api::transaction.transaction').findMany({
        where: { users_permissions_user: userId },
        orderBy: { createdAt: 'ASC' }
      });
      
      let calculatedMainBalance = 0;
      let calculatedPromoBalance = 0;
      
      userTransactions.forEach(tx => {
        const amount = parseFloat(tx.amount || 0);
        const fundSource = tx.fund_source;
        
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
      
      const newTotalBalance = calculatedMainBalance + calculatedPromoBalance;
      
      console.log(`  📊 Calculated: Main=$${calculatedMainBalance}, Promo=$${calculatedPromoBalance}, Total=$${newTotalBalance}`);
      console.log(`  📊 Current: Main=$${wallet.mainBalance}, Promo=$${wallet.promoBalance}, Total=$${wallet.balance}`);
      
      // Update wallet if balances are different
      if (calculatedMainBalance !== parseFloat(wallet.mainBalance) || 
          calculatedPromoBalance !== parseFloat(wallet.promoBalance)) {
        
        await strapi.entityService.update('api::user-wallet.user-wallet', wallet.id, {
          data: {
            mainBalance: calculatedMainBalance,
            promoBalance: calculatedPromoBalance,
            balance: newTotalBalance
          }
        });
        
        console.log(`  ✅ Updated wallet balances`);
      } else {
        console.log(`  ✅ Balances already correct`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    if (strapi) {
      await strapi.destroy();
    }
  }
}

// Run the fix
fixPromoTransactions()
  .then(() => {
    console.log('\n🎉 Promo transaction fix completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Fix failed:', error);
    process.exit(1);
  });
