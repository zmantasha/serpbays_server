'use strict';

/**
 * Offer controller
 * Handles API endpoints for fetching and applying offers.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::offer.offer', ({ strapi }) => ({
    /**
     * GET /api/offers/applicable
     * Returns all offers applicable for the given amount and optional coupon code
     */
    async getApplicableOffers(ctx) {
        try {
            const userId = ctx.state?.user?.id;
            const { amount, couponCode } = ctx.query;

            if (!amount) {
                return ctx.badRequest('Amount is required');
            }

            const parsedAmount = parseFloat(amount);
            if (isNaN(parsedAmount) || parsedAmount <= 0) {
                return ctx.badRequest('Invalid amount');
            }

            const offerEngine = strapi.service('api::offer.offer-engine');
            const applicableOffers = await offerEngine.getApplicableOffers(userId, parsedAmount, couponCode || null);

            return { data: applicableOffers };
        } catch (error) {
            console.error('[OFFER] Error getting applicable offers:', error);
            return ctx.internalServerError('Failed to fetch offers');
        }
    },

    /**
     * POST /api/offers/apply
     * Validates and returns the bonus calculation for a recharge
     */
    async applyOffers(ctx) {
        try {
            const userId = ctx.state?.user?.id;
            const { amount, couponCode } = ctx.request.body;

            if (!amount) {
                return ctx.badRequest('Amount is required');
            }

            const parsedAmount = parseFloat(amount);
            if (isNaN(parsedAmount) || parsedAmount <= 0) {
                return ctx.badRequest('Invalid amount');
            }

            const offerEngine = strapi.service('api::offer.offer-engine');
            const result = await offerEngine.applyOffers(userId, parsedAmount, couponCode || null);

            return { data: result };
        } catch (error) {
            console.error('[OFFER] Error applying offers:', error);
            return ctx.internalServerError('Failed to apply offers');
        }
    },

    /**
     * POST /api/offers/validate-coupon
     * Checks if a coupon code is valid and returns the associated offer
     */
    async validateCoupon(ctx) {
        try {
            const userId = ctx.state?.user?.id;
            const { couponCode, amount } = ctx.request.body;

            if (!couponCode) {
                return ctx.badRequest('Coupon code is required');
            }

            const now = new Date();
            const offer = await strapi.db.query('api::offer.offer').findOne({
                where: {
                    couponCode: couponCode.toUpperCase(),
                    isEnabled: true,
                    startDate: { $lte: now },
                    endDate: { $gte: now },
                },
            });

            if (!offer) {
                return { data: { isValid: false, message: 'Invalid or expired coupon code' } };
            }

            // Validate the offer for this user
            const offerEngine = strapi.service('api::offer.offer-engine');
            const validation = await offerEngine.validateOffer(offer, userId, parseFloat(amount) || 0, couponCode);

            if (!validation.isValid) {
                return { data: { isValid: false, message: validation.errors[0] || 'Coupon not applicable' } };
            }

            const bonus = offerEngine.calculateBonus(offer, parseFloat(amount) || 0);

            return {
                data: {
                    isValid: true,
                    offer: {
                        id: offer.id,
                        title: offer.title,
                        description: offer.description,
                        bonusType: offer.bonusType,
                        bonusValue: offer.bonusValue,
                        maxBonusCap: offer.maxBonusCap,
                        bonusAmount: bonus,
                    },
                },
            };
        } catch (error) {
            console.error('[OFFER] Error validating coupon:', error);
            return ctx.internalServerError('Failed to validate coupon');
        }
    },

    /**
     * GET /api/offers/stats (admin)
     * Returns offer usage statistics
     */
    async getStats(ctx) {
        try {
            const totalOffers = await strapi.db.query('api::offer.offer').count({});
            const activeOffers = await strapi.db.query('api::offer.offer').count({
                where: {
                    isEnabled: true,
                    startDate: { $lte: new Date() },
                    endDate: { $gte: new Date() },
                },
            });
            const totalRedemptions = await strapi.db.query('api::offer-usage.offer-usage').count({});

            // Sum total bonus distributed
            const usages = await strapi.db.query('api::offer-usage.offer-usage').findMany({
                select: ['bonusAmount'],
            });
            const totalBonusDistributed = usages.reduce((sum, u) => sum + parseFloat(u.bonusAmount || 0), 0);

            return {
                data: {
                    totalOffers,
                    activeOffers,
                    totalRedemptions,
                    totalBonusDistributed: Math.round(totalBonusDistributed * 100) / 100,
                },
            };
        } catch (error) {
            console.error('[OFFER] Error getting stats:', error);
            return ctx.internalServerError('Failed to fetch offer stats');
        }
    },

    /**
     * Override default create to validate uniqueness constraints
     */
    async create(ctx) {
        const data = ctx.request.body?.data;
        if (data) {
            // Prevent duplicate first_recharge offers
            if (data.offerType === 'first_recharge') {
                const existingFirstRecharge = await strapi.db.query('api::offer.offer').findOne({
                    where: {
                        offerType: 'first_recharge',
                        isEnabled: true,
                    },
                });
                if (existingFirstRecharge) {
                    return ctx.badRequest(
                        `An active "First Recharge" offer already exists: "${existingFirstRecharge.title}" (ID: ${existingFirstRecharge.id}). ` +
                        `Disable it first before creating a new one.`
                    );
                }
            }

            // Prevent duplicate coupon codes across active offers
            if (data.couponCode && data.couponCode.trim()) {
                const existingCoupon = await strapi.db.query('api::offer.offer').findOne({
                    where: {
                        couponCode: data.couponCode.toUpperCase().trim(),
                        isEnabled: true,
                    },
                });
                if (existingCoupon) {
                    return ctx.badRequest(
                        `Coupon code "${data.couponCode.toUpperCase()}" is already in use by offer "${existingCoupon.title}" (ID: ${existingCoupon.id}).`
                    );
                }
            }

            // Normalize coupon code to uppercase
            if (data.couponCode) {
                ctx.request.body.data.couponCode = data.couponCode.toUpperCase().trim();
            }
        }

        // Call default Strapi create
        return await super.create(ctx);
    },

    /**
     * Override default update to validate uniqueness constraints
     */
    async update(ctx) {
        const { id } = ctx.params;
        const data = ctx.request.body?.data;
        if (data) {
            // Prevent duplicate first_recharge offers (excluding self)
            if (data.offerType === 'first_recharge') {
                const existingFirstRecharge = await strapi.db.query('api::offer.offer').findOne({
                    where: {
                        offerType: 'first_recharge',
                        isEnabled: true,
                        id: { $ne: id },
                    },
                });
                if (existingFirstRecharge) {
                    return ctx.badRequest(
                        `An active "First Recharge" offer already exists: "${existingFirstRecharge.title}" (ID: ${existingFirstRecharge.id}). ` +
                        `Disable it first before updating this one to type "First Recharge".`
                    );
                }
            }

            // Prevent duplicate coupon codes (excluding self)
            if (data.couponCode && data.couponCode.trim()) {
                const existingCoupon = await strapi.db.query('api::offer.offer').findOne({
                    where: {
                        couponCode: data.couponCode.toUpperCase().trim(),
                        isEnabled: true,
                        id: { $ne: id },
                    },
                });
                if (existingCoupon) {
                    return ctx.badRequest(
                        `Coupon code "${data.couponCode.toUpperCase()}" is already in use by offer "${existingCoupon.title}" (ID: ${existingCoupon.id}).`
                    );
                }
            }

            // Normalize coupon code to uppercase
            if (data.couponCode) {
                ctx.request.body.data.couponCode = data.couponCode.toUpperCase().trim();
            }
        }

        // Call default Strapi update
        return await super.update(ctx);
    },
}));
