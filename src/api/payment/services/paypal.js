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
const strapi_1 = require("@strapi/strapi");
const axios_1 = __importDefault(require("axios"));
exports.default = strapi_1.factories.createCoreService('api::payment.paypal', ({ strapi }) => ({
    getAccessToken: () => __awaiter(void 0, void 0, void 0, function* () {
        const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
        const baseURL = process.env.NODE_ENV === 'production'
            ? 'https://api-m.paypal.com'
            : 'https://api-m.sandbox.paypal.com';
        try {
            const response = yield axios_1.default.post(`${baseURL}/v1/oauth2/token`, 'grant_type=client_credentials', {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            return response.data.access_token;
        }
        catch (error) {
            strapi.log.error('PayPal authentication failed:', error);
            throw new Error('Failed to authenticate with PayPal');
        }
    }),
    createPayment(amount) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const accessToken = yield this.getAccessToken();
                const baseURL = process.env.NODE_ENV === 'production'
                    ? 'https://api-m.paypal.com'
                    : 'https://api-m.sandbox.paypal.com';
                const response = yield axios_1.default.post(`${baseURL}/v2/checkout/orders`, {
                    intent: 'CAPTURE',
                    purchase_units: [{
                            amount: {
                                currency_code: 'USD',
                                value: amount.toString()
                            }
                        }]
                }, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                });
                const order = response.data;
                return {
                    id: order.id,
                    status: order.status,
                    links: order.links
                };
            }
            catch (error) {
                strapi.log.error('PayPal payment creation failed:', error);
                throw new Error('Failed to create PayPal payment');
            }
        });
    },
    createPayout(amount) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const accessToken = yield this.getAccessToken();
                const baseURL = process.env.NODE_ENV === 'production'
                    ? 'https://api-m.paypal.com'
                    : 'https://api-m.sandbox.paypal.com';
                const response = yield axios_1.default.post(`${baseURL}/v1/payments/payouts`, {
                    sender_batch_header: {
                        sender_batch_id: `payout_${Date.now()}`,
                        email_subject: "You have a payout!"
                    },
                    items: [{
                            recipient_type: "EMAIL",
                            amount: {
                                value: amount.toString(),
                                currency: "USD"
                            },
                            note: "Thanks for your patronage!",
                            receiver: process.env.PAYPAL_RECEIVER_EMAIL,
                            sender_item_id: `item_${Date.now()}`
                        }]
                }, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                });
                const payout = response.data;
                return {
                    id: payout.batch_header.payout_batch_id,
                    status: payout.batch_header.batch_status,
                    amount: amount
                };
            }
            catch (error) {
                strapi.log.error('PayPal payout creation failed:', error);
                throw new Error('Failed to create PayPal payout');
            }
        });
    },
    capturePayment(orderId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const accessToken = yield this.getAccessToken();
                const baseURL = process.env.NODE_ENV === 'production'
                    ? 'https://api-m.paypal.com'
                    : 'https://api-m.sandbox.paypal.com';
                const response = yield axios_1.default.post(`${baseURL}/v2/checkout/orders/${orderId}/capture`, {}, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                });
                const capture = response.data;
                return {
                    id: capture.id,
                    status: capture.status,
                    amount: capture.purchase_units[0].payments.captures[0].amount.value
                };
            }
            catch (error) {
                strapi.log.error('PayPal payment capture failed:', error);
                throw new Error('Failed to capture PayPal payment');
            }
        });
    }
}));
