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
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var strapi_1 = require("@strapi/strapi");
exports.default = strapi_1.factories.createCoreController('api::user-wallet.user-wallet', function (_a) {
    var strapi = _a.strapi;
    return ({
        // Custom wallet endpoint to get current balance
        getWallet: function (ctx) {
            return __awaiter(this, void 0, void 0, function () {
                var userId, wallet, newWallet, createError_1, transactions, calculatedBalance, successfulTransactions, _i, successfulTransactions_1, transaction, amount, updateError_1, error_1;
                var _a, _b;
                return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0:
                            _c.trys.push([0, 11, , 12]);
                            userId = (_b = (_a = ctx.state) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.id;
                            console.log('UserId', userId);
                            // Require authentication in all environments
                            if (!userId) {
                                return [2 /*return*/, ctx.unauthorized('Authentication required')];
                            }
                            console.log('Getting wallet for user ID:', userId);
                            return [4 /*yield*/, strapi.db.query('api::user-wallet.user-wallet').findOne({
                                    where: { user: userId }
                                })];
                        case 1:
                            wallet = _c.sent();
                            if (!!wallet) return [3 /*break*/, 5];
                            console.log('No wallet found for user:', userId);
                            _c.label = 2;
                        case 2:
                            _c.trys.push([2, 4, , 5]);
                            return [4 /*yield*/, strapi.entityService.create('api::user-wallet.user-wallet', {
                                    data: {
                                        user: userId,
                                        // Use string for balance to avoid TypeScript errors
                                        balance: "0",
                                        escrowBalance: "0",
                                        currency: 'USD',
                                        publishedAt: new Date()
                                    }
                                })];
                        case 3:
                            newWallet = _c.sent();
                            return [2 /*return*/, {
                                    id: newWallet.id,
                                    balance: 0,
                                    escrowBalance: 0,
                                    currency: 'USD'
                                }];
                        case 4:
                            createError_1 = _c.sent();
                            console.error('Error creating wallet:', createError_1);
                            return [2 /*return*/, ctx.badRequest('Failed to create wallet')];
                        case 5: return [4 /*yield*/, strapi.db.query('api::transaction.transaction').findMany({
                                where: { user_wallet: wallet.id }
                            })];
                        case 6:
                            transactions = _c.sent();
                            console.log("Found ".concat(transactions.length, " total transactions for wallet"));
                            calculatedBalance = 0;
                            successfulTransactions = transactions.filter(function (t) {
                                return t.transactionStatus === 'success' ||
                                    t.status === 'success' ||
                                    t.status === 'published';
                            });
                            console.log("Found ".concat(successfulTransactions.length, " successful transactions"));
                            for (_i = 0, successfulTransactions_1 = successfulTransactions; _i < successfulTransactions_1.length; _i++) {
                                transaction = successfulTransactions_1[_i];
                                amount = parseFloat(transaction.amount) || 0;
                                if (transaction.type === 'deposit') {
                                    calculatedBalance += amount;
                                }
                                else if (transaction.type === 'withdrawal') {
                                    calculatedBalance -= amount;
                                }
                            }
                            console.log('Stored balance in DB:', wallet.balance);
                            console.log('Calculated balance from transactions:', calculatedBalance);
                            if (!(Math.abs(calculatedBalance - parseFloat(wallet.balance)) > 0.001)) return [3 /*break*/, 10];
                            console.log('Updating wallet balance to match transactions');
                            _c.label = 7;
                        case 7:
                            _c.trys.push([7, 9, , 10]);
                            return [4 /*yield*/, strapi.db.query('api::user-wallet.user-wallet').update({
                                    where: { id: wallet.id },
                                    data: { balance: calculatedBalance.toString() }
                                })];
                        case 8:
                            _c.sent();
                            console.log('Successfully updated wallet balance in database');
                            return [3 /*break*/, 10];
                        case 9:
                            updateError_1 = _c.sent();
                            console.error('Error updating wallet balance:', updateError_1);
                            return [3 /*break*/, 10];
                        case 10: 
                        // Return the calculated balance, not the stored one
                        return [2 /*return*/, {
                                id: wallet.id,
                                balance: calculatedBalance,
                                escrowBalance: parseFloat(wallet.escrowBalance) || 0,
                                currency: wallet.currency || 'USD'
                            }];
                        case 11:
                            error_1 = _c.sent();
                            console.error('Error getting wallet:', error_1);
                            return [2 /*return*/, ctx.badRequest('Failed to get wallet')];
                        case 12: return [2 /*return*/];
                    }
                });
            });
        }
    });
});
