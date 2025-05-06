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
exports.default = strapi_1.factories.createCoreController('api::transaction.transaction', function (_a) {
    var strapi = _a.strapi;
    return ({
        // Override the default find method
        find: function (ctx) {
            return __awaiter(this, void 0, void 0, function () {
                var userId, wallet, transactions, transformedTransactions, error_1;
                var _a, _b;
                return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0:
                            _c.trys.push([0, 3, , 4]);
                            userId = (_b = (_a = ctx.state) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.id;
                            // Require authentication
                            if (!userId) {
                                return [2 /*return*/, ctx.unauthorized('Authentication required')];
                            }
                            console.log('Finding transactions for user:', userId);
                            return [4 /*yield*/, strapi.db.query('api::user-wallet.user-wallet').findOne({
                                    where: { user: userId },
                                })];
                        case 1:
                            wallet = _c.sent();
                            if (!wallet) {
                                console.error('Wallet not found for user:', userId);
                                return [2 /*return*/, ctx.badRequest('User wallet not found')];
                            }
                            console.log('Found wallet ID:', wallet.id);
                            return [4 /*yield*/, strapi.db.query('api::transaction.transaction').findMany({
                                    where: { user_wallet: wallet.id },
                                    orderBy: { createdAt: 'desc' },
                                    populate: true
                                })];
                        case 2:
                            transactions = _c.sent();
                            console.log("Found ".concat(transactions.length, " raw transactions"));
                            transformedTransactions = transactions.map(function (transaction) { return ({
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
                            }); });
                            // Return in the format expected by the frontend
                            return [2 /*return*/, {
                                    data: transformedTransactions,
                                    meta: {
                                        pagination: {
                                            page: 1,
                                            pageSize: transformedTransactions.length,
                                            pageCount: 1,
                                            total: transformedTransactions.length
                                        }
                                    }
                                }];
                        case 3:
                            error_1 = _c.sent();
                            console.error('Error finding transactions:', error_1);
                            return [2 /*return*/, ctx.badRequest('Failed to find transactions: ' + error_1.message)];
                        case 4: return [2 /*return*/];
                    }
                });
            });
        },
        // Override the default create method
        create: function (ctx) {
            return __awaiter(this, void 0, void 0, function () {
                var data, userId, wallet, transaction, gateway, payment, paymentError_1, error_2;
                var _a, _b;
                return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0:
                            _c.trys.push([0, 8, , 9]);
                            data = ctx.request.body.data;
                            console.log('Creating transaction with data:', data);
                            userId = (_b = (_a = ctx.state) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.id;
                            // Require authentication
                            if (!userId) {
                                return [2 /*return*/, ctx.unauthorized('Authentication required')];
                            }
                            console.log('Using user ID:', userId);
                            return [4 /*yield*/, strapi.db.query('api::user-wallet.user-wallet').findOne({
                                    where: { user: userId },
                                })];
                        case 1:
                            wallet = _c.sent();
                            if (!wallet) {
                                console.error('Wallet not found for user:', userId);
                                return [2 /*return*/, ctx.badRequest('User wallet not found')];
                            }
                            console.log('Found wallet:', wallet.id, 'with balance:', wallet.balance);
                            return [4 /*yield*/, strapi.entityService.create('api::transaction.transaction', {
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
                                })];
                        case 2:
                            transaction = _c.sent();
                            console.log('Transaction created:', transaction.id);
                            if (!(data.type === 'deposit' || !data.type)) return [3 /*break*/, 7];
                            _c.label = 3;
                        case 3:
                            _c.trys.push([3, 5, , 7]);
                            gateway = data.gateway || 'test';
                            console.log("Initiating payment using ".concat(gateway, " gateway"));
                            return [4 /*yield*/, strapi.service('api::user-wallet.payment').createPayment(transaction, gateway)];
                        case 4:
                            payment = _c.sent();
                            console.log('Payment gateway response:', payment);
                            // Return the transaction and payment info
                            return [2 /*return*/, {
                                    transaction: transaction,
                                    payment: payment,
                                    success: true,
                                    message: "Payment initiated with ".concat(gateway)
                                }];
                        case 5:
                            paymentError_1 = _c.sent();
                            console.error('Error processing payment:', paymentError_1);
                            // Update transaction to failed status
                            return [4 /*yield*/, strapi.db.query('api::transaction.transaction').update({
                                    where: { id: transaction.id },
                                    data: {
                                        transactionStatus: 'failed',
                                        status: 'failed',
                                    }
                                })];
                        case 6:
                            // Update transaction to failed status
                            _c.sent();
                            return [2 /*return*/, ctx.badRequest("Payment processing failed: ".concat(paymentError_1.message))];
                        case 7: return [2 /*return*/, { transaction: transaction }];
                        case 8:
                            error_2 = _c.sent();
                            console.error('Error creating transaction:', error_2);
                            return [2 /*return*/, ctx.badRequest('Failed to create transaction: ' + error_2.message)];
                        case 9: return [2 /*return*/];
                    }
                });
            });
        }
    });
});
