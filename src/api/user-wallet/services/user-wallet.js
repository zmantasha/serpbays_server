"use strict";
/**
 * user-wallet service
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
exports.default = strapi_1.factories.createCoreService('api::user-wallet.user-wallet', ({ strapi }) => ({
    createWallet(userId_1) {
        return __awaiter(this, arguments, void 0, function* (userId, type = 'advertiser') {
            // Check if wallet already exists
            const existingWallet = yield strapi.db.query('api::user-wallet.user-wallet').findOne({
                where: { user: userId }
            });
            if (existingWallet) {
                return existingWallet;
            }
            // Create new wallet
            return yield strapi.entityService.create('api::user-wallet.user-wallet', {
                data: {
                    type,
                    currency: 'USD',
                    balance: 0,
                    escrowBalance: 0,
                    user: userId,
                    publishedAt: new Date()
                }
            });
        });
    },
    getWallet(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            const wallet = yield strapi.db.query('api::user-wallet.user-wallet').findOne({
                where: { user: userId }
            });
            if (!wallet) {
                return this.createWallet(userId);
            }
            return wallet;
        });
    },
    createTransaction(walletId, data) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield strapi.entityService.create('api::wallet-transaction.wallet-transaction', {
                data: Object.assign(Object.assign({}, data), { wallet: walletId, status: 'pending', publishedAt: new Date() })
            });
        });
    },
    updateWalletBalance(walletId, amount, type) {
        return __awaiter(this, void 0, void 0, function* () {
            const wallet = yield strapi.entityService.findOne('api::user-wallet.user-wallet', walletId);
            if (!wallet) {
                throw new Error('Wallet not found');
            }
            let newBalance = wallet.balance;
            let newEscrowBalance = wallet.escrowBalance;
            switch (type) {
                case 'deposit':
                    newBalance += amount;
                    break;
                case 'escrow_hold':
                    newBalance -= amount;
                    newEscrowBalance += amount;
                    break;
                case 'escrow_release':
                    newEscrowBalance -= amount;
                    break;
                case 'fee':
                    newBalance -= amount;
                    break;
                case 'refund':
                    newBalance += amount;
                    break;
                case 'payout':
                    newBalance -= amount;
                    break;
                default:
                    throw new Error('Invalid transaction type');
            }
            return yield strapi.entityService.update('api::user-wallet.user-wallet', walletId, {
                data: {
                    balance: newBalance,
                    escrowBalance: newEscrowBalance
                }
            });
        });
    },
    getTransactions(walletId_1) {
        return __awaiter(this, arguments, void 0, function* (walletId, filters = {}) {
            return yield strapi.db.query('api::wallet-transaction.wallet-transaction').findMany({
                where: Object.assign({ wallet: walletId }, filters),
                orderBy: { createdAt: 'DESC' }
            });
        });
    }
}));
