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
    getWallet(ctx) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log(ctx);
            try {
                const userId = ctx.state.user.id;
                const wallet = yield strapi.service('api::user-wallet.user-wallet').getWallet(userId);
                return ctx.send({
                    data: wallet
                });
            }
            catch (error) {
                return ctx.badRequest('Failed to get wallet', { error: error.message });
            }
        });
    },
    addFunds(ctx) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const userId = ctx.state.user.id;
                const { amount, gateway } = ctx.request.body;
                console.log(userId);
                if (!amount || amount <= 0) {
                    return ctx.badRequest('Invalid amount');
                }
                const wallet = yield strapi.service('api::user-wallet.user-wallet').getWallet(userId);
                // Create pending transaction
                const transaction = yield strapi.service('api::user-wallet.user-wallet').createTransaction(wallet.id, {
                    type: 'deposit',
                    amount,
                    gateway,
                    status: 'pending'
                });
                // Initialize payment gateway based on selection
                let paymentData;
                switch (gateway) {
                    case 'razorpay':
                        paymentData = yield strapi.service('api::payment.razorpay').createOrder(amount);
                        break;
                    case 'paypal':
                        paymentData = yield strapi.service('api::payment.paypal').createPayment(amount);
                        break;
                    case 'stripe':
                        paymentData = yield strapi.service('api::payment.stripe').createPaymentIntent(amount);
                        break;
                    default:
                        return ctx.badRequest('Invalid payment gateway');
                }
                return ctx.send({
                    data: {
                        transaction,
                        payment: paymentData
                    }
                });
            }
            catch (error) {
                return ctx.badRequest('Failed to add funds', { error: error.message });
            }
        });
    },
    getTransactions(ctx) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const userId = ctx.state.user.id;
                const wallet = yield strapi.service('api::user-wallet.user-wallet').getWallet(userId);
                const transactions = yield strapi.service('api::user-wallet.user-wallet').getTransactions(wallet.id);
                return ctx.send({
                    data: transactions
                });
            }
            catch (error) {
                return ctx.badRequest('Failed to get transactions', { error: error.message });
            }
        });
    },
    processEscrow(ctx) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { walletId, amount, type } = ctx.request.body;
                if (!amount || amount <= 0) {
                    return ctx.badRequest('Invalid amount');
                }
                // Create transaction
                const transaction = yield strapi.service('api::user-wallet.user-wallet').createTransaction(walletId, {
                    type,
                    amount,
                    status: 'pending'
                });
                // Update wallet balance
                yield strapi.service('api::user-wallet.user-wallet').updateWalletBalance(walletId, amount, type);
                // Update transaction status
                yield strapi.entityService.update('api::wallet-transaction.wallet-transaction', transaction.id, {
                    data: { status: 'success' }
                });
                return ctx.send({
                    data: transaction
                });
            }
            catch (error) {
                return ctx.badRequest('Failed to process escrow', { error: error.message });
            }
        });
    },
    processPayout(ctx) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { walletId, amount, gateway } = ctx.request.body;
                if (!amount || amount <= 0) {
                    return ctx.badRequest('Invalid amount');
                }
                const wallet = yield strapi.entityService.findOne('api::user-wallet.user-wallet', walletId);
                if (!wallet || wallet.balance < amount) {
                    return ctx.badRequest('Insufficient balance');
                }
                // Create transaction
                const transaction = yield strapi.service('api::user-wallet.user-wallet').createTransaction(walletId, {
                    type: 'payout',
                    amount,
                    gateway,
                    status: 'pending'
                });
                // Initialize payout based on gateway
                let payoutData;
                switch (gateway) {
                    case 'razorpay':
                        payoutData = yield strapi.service('api::payment.razorpay').createPayout(amount);
                        break;
                    case 'paypal':
                        payoutData = yield strapi.service('api::payment.paypal').createPayout(amount);
                        break;
                    case 'stripe':
                        payoutData = yield strapi.service('api::payment.stripe').createPayout(amount);
                        break;
                    default:
                        return ctx.badRequest('Invalid payout gateway');
                }
                // Update wallet balance
                yield strapi.service('api::user-wallet.user-wallet').updateWalletBalance(walletId, amount, 'payout');
                // Update transaction status
                yield strapi.entityService.update('api::wallet-transaction.wallet-transaction', transaction.id, {
                    data: {
                        status: 'success',
                        gatewayTransactionId: payoutData.id
                    }
                });
                return ctx.send({
                    data: {
                        transaction,
                        payout: payoutData
                    }
                });
            }
            catch (error) {
                return ctx.badRequest('Failed to process payout', { error: error.message });
            }
        });
    }
}));
