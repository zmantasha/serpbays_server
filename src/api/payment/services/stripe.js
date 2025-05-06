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
const stripe_1 = __importDefault(require("stripe"));
exports.default = strapi_1.factories.createCoreService('api::payment.stripe', ({ strapi }) => ({
    getClient() {
        return new stripe_1.default(process.env.STRIPE_SECRET_KEY, {
            apiVersion: '2023-10-16'
        });
    },
    createPaymentIntent(amount) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const stripe = this.getClient();
                const paymentIntent = yield stripe.paymentIntents.create({
                    amount: Math.round(amount * 100), // Convert to cents
                    currency: 'usd',
                    automatic_payment_methods: {
                        enabled: true,
                    },
                });
                return {
                    id: paymentIntent.id,
                    clientSecret: paymentIntent.client_secret,
                    amount: paymentIntent.amount,
                    status: paymentIntent.status
                };
            }
            catch (error) {
                strapi.log.error('Stripe payment intent creation failed:', error);
                throw new Error('Failed to create Stripe payment intent');
            }
        });
    },
    createPayout(amount) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const stripe = this.getClient();
                const payout = yield stripe.payouts.create({
                    amount: Math.round(amount * 100), // Convert to cents
                    currency: 'usd',
                    method: 'standard',
                    destination: process.env.STRIPE_DESTINATION_ACCOUNT_ID
                });
                return {
                    id: payout.id,
                    amount: payout.amount,
                    status: payout.status,
                    arrival_date: payout.arrival_date
                };
            }
            catch (error) {
                strapi.log.error('Stripe payout creation failed:', error);
                throw new Error('Failed to create Stripe payout');
            }
        });
    },
    confirmPayment(paymentIntentId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const stripe = this.getClient();
                const paymentIntent = yield stripe.paymentIntents.retrieve(paymentIntentId);
                if (paymentIntent.status === 'succeeded') {
                    return {
                        id: paymentIntent.id,
                        status: paymentIntent.status,
                        amount: paymentIntent.amount
                    };
                }
                throw new Error('Payment not succeeded');
            }
            catch (error) {
                strapi.log.error('Stripe payment confirmation failed:', error);
                throw new Error('Failed to confirm Stripe payment');
            }
        });
    }
}));
