"use strict";
/**
 * transaction controller
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
exports.default = strapi_1.factories.createCoreController('api::transaction.transaction', ({ strapi }) => ({
    // Override the default find method
    find(ctx) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                // Get the user ID from context
                const userId = (_b = (_a = ctx.state) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.id;
                // Require authentication
                if (!userId) {
                    return ctx.unauthorized('Authentication required');
                }
                console.log('Finding transactions for user:', userId);
                // Find the user's wallet
                const wallet = yield strapi.db.query('api::user-wallet.user-wallet').findOne({
                    where: { user: userId },
                });
                if (!wallet) {
                    console.error('Wallet not found for user:', userId);
                    return ctx.badRequest('User wallet not found');
                }
                console.log('Found wallet ID:', wallet.id);
                // Directly query the database to get ALL transactions
                const transactions = yield strapi.db.query('api::transaction.transaction').findMany({
                    where: { user_wallet: wallet.id },
                    orderBy: { createdAt: 'desc' },
                    populate: true
                });
                console.log(`Found ${transactions.length} raw transactions`);
                // Transform into the expected response format
                const transformedTransactions = transactions.map(transaction => ({
                    id: transaction.id,
                    attributes: {
                        amount: transaction.amount,
                        type: transaction.type,
                        date: transaction.date || transaction.createdAt,
                        transactionStatus: transaction.transactionStatus,
                        status: transaction.status || transaction.transactionStatus || 'pending',
                        gateway: transaction.gateway,
                        createdAt: transaction.createdAt,
                        updatedAt: transaction.updatedAt,
                        publishedAt: transaction.publishedAt
                    }
                }));
                // Return in the format expected by the frontend
                return {
                    data: transformedTransactions,
                    meta: {
                        pagination: {
                            page: 1,
                            pageSize: transformedTransactions.length,
                            pageCount: 1,
                            total: transformedTransactions.length
                        }
                    }
                };
            }
            catch (error) {
                console.error('Error finding transactions:', error);
                return ctx.badRequest('Failed to find transactions: ' + error.message);
            }
        });
    },
    // Override the default create method
    create(ctx) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const { data } = ctx.request.body;
                console.log('Creating transaction with data:', data);
                // Get the user ID from request or context
                const userId = (_b = (_a = ctx.state) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.id;
                // Require authentication
                if (!userId) {
                    return ctx.unauthorized('Authentication required');
                }
                console.log('Using user ID:', userId);
                // Find the user's wallet
                const wallet = yield strapi.db.query('api::user-wallet.user-wallet').findOne({
                    where: { user: userId },
                });
                if (!wallet) {
                    console.error('Wallet not found for user:', userId);
                    return ctx.badRequest('User wallet not found');
                }
                console.log('Found wallet:', wallet.id, 'with balance:', wallet.balance);
                // Create the transaction linked to the wallet
                const transaction = yield strapi.entityService.create('api::transaction.transaction', {
                    data: {
                        amount: data.amount,
                        type: data.type || 'deposit',
                        gateway: data.gateway || 'test',
                        transactionStatus: 'pending',
                        status: 'pending', // Add status field for frontend compatibility
                        user_wallet: wallet.id,
                        date: new Date().toISOString(),
                        publishedAt: new Date().toISOString(),
                    },
                });
                console.log('Transaction created:', transaction.id);
                // For deposits, process the payment with the appropriate gateway
                if (data.type === 'deposit' || !data.type) {
                    try {
                        // Use the payment service to create a payment with the specified gateway
                        const gateway = data.gateway || 'test';
                        console.log(`Initiating payment using ${gateway} gateway`);
                        const payment = yield strapi.service('api::user-wallet.payment').createPayment(transaction, gateway);
                        console.log('Payment gateway response:', payment);
                        // Return the transaction and payment info
                        return {
                            transaction,
                            payment,
                            success: true,
                            message: `Payment initiated with ${gateway}`
                        };
                    }
                    catch (paymentError) {
                        console.error('Error processing payment:', paymentError);
                        // Update transaction to failed status
                        yield strapi.db.query('api::transaction.transaction').update({
                            where: { id: transaction.id },
                            data: {
                                transactionStatus: 'failed',
                                status: 'failed',
                            }
                        });
                        return ctx.badRequest(`Payment processing failed: ${paymentError.message}`);
                    }
                }
                return { transaction };
            }
            catch (error) {
                console.error('Error creating transaction:', error);
                return ctx.badRequest('Failed to create transaction: ' + error.message);
            }
        });
    }
}));
