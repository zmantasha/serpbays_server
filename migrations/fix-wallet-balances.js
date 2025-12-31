/**
 * Migration Script: Fix Wallet Balances After Escrow Bug
 * 
 * This script recalculates wallet balances based on transactions
 * to fix any inconsistencies caused by the escrow refund bug.
 * 
 * Run this ONCE after deploying the fix.
 */

module.exports = {
    async up() {
        const strapi = require('@strapi/strapi')();
        await strapi.load();

        console.log('🔧 Starting wallet balance fix migration...\n');

        try {
            // Get all wallets
            const wallets = await strapi.db.query('api::user-wallet.user-wallet').findMany({
                populate: ['users_permissions_user']
            });

            console.log(`Found ${wallets.length} wallets to check\n`);

            let fixedCount = 0;
            let skippedCount = 0;

            for (const wallet of wallets) {
                const userId = wallet.users_permissions_user?.id || wallet.users_permissions_user;

                console.log(`\n--- Checking Wallet ID: ${wallet.id} (User: ${userId}) ---`);
                console.log(`Current balances:`);
                console.log(`  Main: $${wallet.mainBalance}`);
                console.log(`  Promo: $${wallet.promoBalance}`);
                console.log(`  Escrow: $${wallet.escrowBalance}`);
                console.log(`  Total: $${wallet.balance}`);

                // Calculate what the balance SHOULD be
                const expectedBalance =
                    parseFloat(wallet.mainBalance || 0) +
                    parseFloat(wallet.promoBalance || 0) +
                    parseFloat(wallet.escrowBalance || 0);

                const currentBalance = parseFloat(wallet.balance || 0);
                const difference = Math.abs(expectedBalance - currentBalance);

                console.log(`  Expected Total: $${expectedBalance}`);
                console.log(`  Difference: $${difference.toFixed(2)}`);

                // If difference is more than 0.01 (accounting for floating point), fix it
                if (difference > 0.01) {
                    console.log(`  ⚠️  Balance mismatch detected! Fixing...`);

                    await strapi.db.query('api::user-wallet.user-wallet').update({
                        where: { id: wallet.id },
                        data: {
                            balance: expectedBalance
                        }
                    });

                    console.log(`  ✅ Fixed! New balance: $${expectedBalance}`);
                    fixedCount++;
                } else {
                    console.log(`  ✅ Balance is correct, no fix needed`);
                    skippedCount++;
                }
            }

            console.log(`\n\n=== Migration Complete ===`);
            console.log(`✅ Fixed: ${fixedCount} wallets`);
            console.log(`⏭️  Skipped: ${skippedCount} wallets (already correct)`);
            console.log(`📊 Total: ${wallets.length} wallets checked`);

        } catch (error) {
            console.error('❌ Migration failed:', error);
            throw error;
        } finally {
            await strapi.destroy();
        }
    }
};

// Run if called directly
if (require.main === module) {
    module.exports.up()
        .then(() => {
            console.log('\n✅ Migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Migration failed:', error);
            process.exit(1);
        });
}
