/**
 * Migration: Add separate balance tracking to wallet system
 * This migration adds mainBalance and promoBalance fields to existing wallets
 * and migrates current balance data appropriately
 */

'use strict';

module.exports = {
  async up(knex) {
    console.log('🔄 Starting wallet balance separation migration...');

    try {
      // Check if columns already exist
      const hasMainBalance = await knex.schema.hasColumn('user_wallets', 'main_balance');
      const hasPromoBalance = await knex.schema.hasColumn('user_wallets', 'promo_balance');

      // Only add columns if they don't exist
      if (!hasMainBalance || !hasPromoBalance) {
        await knex.schema.alterTable('user_wallets', (table) => {
          if (!hasMainBalance) table.decimal('main_balance', 10, 2).defaultTo(0).notNullable();
          if (!hasPromoBalance) table.decimal('promo_balance', 10, 2).defaultTo(0).notNullable();
        });

        console.log('✅ Added main_balance and promo_balance columns');
      } else {
        console.log('ℹ️  main_balance and promo_balance columns already exist, skipping');
      }

      // Migrate existing balance data
      // For existing wallets, we'll assume all current balance is main_balance
      // since promo tracking wasn't implemented before
      await knex('user_wallets')
        .update({
          main_balance: knex.raw('balance'),
          promo_balance: 0
        });

      console.log('✅ Migrated existing balance data to main_balance');

      // Check if transaction columns already exist
      const hasPromoCodeId = await knex.schema.hasColumn('transactions', 'promo_code_id');
      const hasFundSource = await knex.schema.hasColumn('transactions', 'fund_source');

      // Add new columns to transactions table only if they don't exist
      if (!hasPromoCodeId || !hasFundSource) {
        await knex.schema.alterTable('transactions', (table) => {
          if (!hasPromoCodeId) table.string('promo_code_id', 255).nullable();
          if (!hasFundSource) table.enum('fund_source', ['main_fund', 'promo_fund']).nullable();
        });

        console.log('✅ Added promo_code_id and fund_source columns to transactions');
      } else {
        console.log('ℹ️  promo_code_id and fund_source columns already exist, skipping');
      }

      // Update existing promo transactions to have fund_source = 'promo_fund'
      await knex('transactions')
        .where('gateway', 'promo')
        .update({
          fund_source: 'promo_fund'
        });

      console.log('✅ Updated existing promo transactions with fund_source');

      // Update existing non-promo transactions to have fund_source = 'main_fund'
      await knex('transactions')
        .whereIn('gateway', ['stripe', 'paypal', 'razorpay', 'system'])
        .update({
          fund_source: 'main_fund'
        });

      console.log('✅ Updated existing non-promo transactions with fund_source');

      console.log('🎉 Wallet balance separation migration completed successfully!');

    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  },

  async down(knex) {
    console.log('🔄 Rolling back wallet balance separation migration...');

    try {
      // Remove columns from transactions table
      await knex.schema.alterTable('transactions', (table) => {
        table.dropColumn('promo_code_id');
        table.dropColumn('fund_source');
      });

      console.log('✅ Removed promo_code_id and fund_source columns from transactions');

      // Remove columns from user_wallets table
      await knex.schema.alterTable('user_wallets', (table) => {
        table.dropColumn('main_balance');
        table.dropColumn('promo_balance');
      });

      console.log('✅ Removed main_balance and promo_balance columns');

      console.log('🎉 Rollback completed successfully!');

    } catch (error) {
      console.error('❌ Rollback failed:', error);
      throw error;
    }
  }
};
