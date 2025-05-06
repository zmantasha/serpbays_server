"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const razorpay_1 = __importDefault(require("razorpay"));
const strapi_1 = require("@strapi/strapi");
exports.default = strapi_1.factories.createCoreService('api::payment.razorpay', ({ strapi }) => ({
    createOrder(amount) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const razorpay = new razorpay_1.default({
                    key_id: process.env.RAZORPAY_KEY_ID,
                    key_secret: process.env.RAZORPAY_KEY_SECRET,
                });
                const order = yield razorpay.orders.create({
                    amount: amount * 100, // Convert to paise
                    currency: 'INR',
                    receipt: `receipt_${Date.now()}`,
                });
                return {
                    id: order.id,
                    amount: order.amount,
                    currency: order.currency,
                    receipt: order.receipt,
                };
            }
            catch (error) {
                strapi.log.error('Razorpay order creation failed:', error);
                throw new Error('Failed to create Razorpay order');
            }
        });
    },
    createPayout(amount) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const razorpay = new razorpay_1.default({
                    key_id: process.env.RAZORPAY_KEY_ID,
                    key_secret: process.env.RAZORPAY_KEY_SECRET,
                });
                const payout = yield razorpay.payouts.create({
                    account_number: process.env.RAZORPAY_ACCOUNT_NUMBER,
                    fund_account_id: process.env.RAZORPAY_FUND_ACCOUNT_ID,
                    amount: amount * 100, // Convert to paise
                    currency: 'INR',
                    mode: 'IMPS',
                    purpose: 'payout',
                });
                return {
                    id: payout.id,
                    amount: payout.amount,
                    currency: payout.currency,
                    status: payout.status,
                };
            }
            catch (error) {
                strapi.log.error('Razorpay payout creation failed:', error);
                throw new Error('Failed to create Razorpay payout');
            }
        });
    },
    verifyPayment(paymentId, orderId, signature) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const razorpay = new razorpay_1.default({
                    key_id: process.env.RAZORPAY_KEY_ID,
                    key_secret: process.env.RAZORPAY_KEY_SECRET,
                });
                const generatedSignature = razorpay.utils.generateSignature(`${orderId}|${paymentId}`, process.env.RAZORPAY_KEY_SECRET);
                return generatedSignature === signature;
            }
            catch (error) {
                strapi.log.error('Razorpay payment verification failed:', error);
                throw new Error('Failed to verify Razorpay payment');
            }
        });
    }
}));
