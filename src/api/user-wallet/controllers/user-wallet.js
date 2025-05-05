"use strict";
/**
 * user-wallet controller
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const strapi_1 = require("@strapi/strapi");
exports.default = strapi_1.factories.createCoreController('api::user-wallet.user-wallet', ({ strapi }) => ({
    // Custom wallet endpoint to get current balance
    getWallet(ctx) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                // Get user ID from context
                const userId = (_b = (_a = ctx.state) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.id;
                console.log('UserId', userId);
                // Require authentication in all environments
                if (!userId) {
                    return ctx.unauthorized('Authentication required');
                }
                console.log('Getting wallet for user ID:', userId);
                // Find the user's wallet with a fresh query
                const wallet = yield strapi.db.query('api::user-wallet.user-wallet').findOne({
                    where: { user: userId }
                });
                if (!wallet) {
                    console.log('No wallet found for user:', userId);
                    // Create a new wallet if not found
                    try {
                        const newWallet = yield strapi.entityService.create('api::user-wallet.user-wallet', {
                            data: {
                                user: userId,
                                // Use string for balance to avoid TypeScript errors
                                balance: "0",
                                escrowBalance: "0",
                                currency: 'USD',
                                publishedAt: new Date()
                            }
                        });
                        return {
                            id: newWallet.id,
                            balance: 0,
                            escrowBalance: 0,
                            currency: 'USD'
                        };
                    }
                    catch (createError) {
                        console.error('Error creating wallet:', createError);
                        return ctx.badRequest('Failed to create wallet');
                    }
                }
                // Get ALL transactions for this wallet (both pending and completed)
                const transactions = yield strapi.db.query('api::transaction.transaction').findMany({
                    where: { user_wallet: wallet.id }
                });
                console.log(`Found ${transactions.length} total transactions for wallet`);
                // Calculate the balance from successful transactions only
                let calculatedBalance = 0;
                // Consider both 'success' transactionStatus and 'published' status as valid
                const successfulTransactions = transactions.filter(t => t.transactionStatus === 'success' ||
                    t.status === 'success' ||
                    t.status === 'published');
                console.log(`Found ${successfulTransactions.length} successful transactions`);
                for (const transaction of successfulTransactions) {
                    const amount = parseFloat(transaction.amount) || 0;
                    if (transaction.type === 'deposit') {
                        calculatedBalance += amount;
                    }
                    else if (transaction.type === 'withdrawal') {
                        calculatedBalance -= amount;
                    }
                }
                console.log('Stored balance in DB:', wallet.balance);
                console.log('Calculated balance from transactions:', calculatedBalance);
                // If there's a discrepancy, update the wallet's balance in the database
                if (Math.abs(calculatedBalance - parseFloat(wallet.balance)) > 0.001) {
                    console.log('Updating wallet balance to match transactions');
                    try {
                        yield strapi.db.query('api::user-wallet.user-wallet').update({
                            where: { id: wallet.id },
                            data: { balance: calculatedBalance.toString() }
                        });
                        console.log('Successfully updated wallet balance in database');
                    }
                    catch (updateError) {
                        console.error('Error updating wallet balance:', updateError);
                        // Continue even if update fails
                    }
                }
                // Return the calculated balance, not the stored one
                return {
                    id: wallet.id,
                    balance: calculatedBalance,
                    escrowBalance: parseFloat(wallet.escrowBalance) || 0,
                    currency: wallet.currency || 'USD'
                };
            }
            catch (error) {
                console.error('Error getting wallet:', error);
                return ctx.badRequest('Failed to get wallet');
            }
        });
    }
}));
