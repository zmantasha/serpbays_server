'use strict';

/**
 * Admin Offers Controller
 * Handles CRUD operations for offers from admin panel
 */

module.exports = {
    /**
     * Get all offers with filtering and pagination
     */
    async find(ctx) {
        try {
            const { page = 1, pageSize = 20, search, offerType, status } = ctx.query;

            const where = {};

            // Search filter
            if (search) {
                where.$or = [
                    { title: { $containsi: search } },
                    { description: { $containsi: search } },
                    { couponCode: { $containsi: search } },
                ];
            }

            // Offer type filter
            if (offerType) {
                where.offerType = offerType;
            }

            // Status filter
            if (status === 'active') {
                where.isEnabled = true;
            } else if (status === 'inactive') {
                where.isEnabled = false;
            }

            const start = (parseInt(page) - 1) * parseInt(pageSize);
            const limit = parseInt(pageSize);

            const [offers, total] = await Promise.all([
                strapi.db.query('api::offer.offer').findMany({
                    where,
                    populate: ['offer_conditions', 'offer_usages'],
                    orderBy: { createdAt: 'desc' },
                    offset: start,
                    limit,
                }),
                strapi.db.query('api::offer.offer').count({ where }),
            ]);

            // Map offers to include usage count
            const mappedOffers = offers.map(offer => ({
                ...offer,
                usageCount: offer.offer_usages?.length || 0,
            }));

            ctx.body = {
                data: mappedOffers,
                meta: {
                    pagination: {
                        page: parseInt(page),
                        pageSize: limit,
                        pageCount: Math.ceil(total / limit),
                        total,
                    },
                },
            };
        } catch (error) {
            strapi.log.error('Admin offers find error:', error);
            ctx.throw(500, 'Failed to fetch offers');
        }
    },

    /**
     * Get offer statistics
     */
    async getStats(ctx) {
        try {
            const now = new Date();

            const [totalOffers, activeOffers, totalUsages] = await Promise.all([
                strapi.db.query('api::offer.offer').count(),
                strapi.db.query('api::offer.offer').count({
                    where: {
                        isEnabled: true,
                        startDate: { $lte: now },
                        endDate: { $gte: now },
                    },
                }),
                strapi.db.query('api::offer-usage.offer-usage').count(),
            ]);

            // Calculate total bonus distributed
            const usages = await strapi.db.query('api::offer-usage.offer-usage').findMany({
                select: ['bonusAmount'],
            });
            const totalBonusDistributed = usages.reduce((sum, u) => sum + (parseFloat(u.bonusAmount) || 0), 0);

            ctx.body = {
                totalOffers,
                activeOffers,
                totalRedemptions: totalUsages,
                totalBonusDistributed,
            };
        } catch (error) {
            strapi.log.error('Admin offers stats error:', error);
            ctx.throw(500, 'Failed to fetch offer stats');
        }
    },

    /**
     * Create a new offer
     */
    async create(ctx) {
        try {
            const { data } = ctx.request.body;

            if (!data || !data.title) {
                return ctx.badRequest('Title is required');
            }

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
                        `An active "First Recharge" offer already exists: "${existingFirstRecharge.title}" (ID: ${existingFirstRecharge.id}). Disable it first before creating a new one.`
                    );
                }
            }

            // Prevent duplicate coupon codes across active offers
            const couponCode = data.couponCode ? data.couponCode.toUpperCase().trim() : null;
            if (couponCode) {
                const existingCoupon = await strapi.db.query('api::offer.offer').findOne({
                    where: {
                        couponCode,
                        isEnabled: true,
                    },
                });
                if (existingCoupon) {
                    return ctx.badRequest(
                        `Coupon code "${couponCode}" is already in use by offer "${existingCoupon.title}" (ID: ${existingCoupon.id}).`
                    );
                }
            }

            const offer = await strapi.entityService.create('api::offer.offer', {
                data: {
                    offerType: data.offerType || 'percentage_bonus',
                    title: data.title,
                    description: data.description || '',
                    bonusType: data.bonusType || 'percentage',
                    bonusValue: parseFloat(data.bonusValue) || 0,
                    maxBonusCap: data.maxBonusCap ? parseFloat(data.maxBonusCap) : null,
                    minRechargeAmount: parseFloat(data.minRechargeAmount) || 0,
                    couponCode: couponCode,
                    applicableUserType: data.applicableUserType || 'all',
                    priority: parseInt(data.priority) || 10,
                    isStackable: data.isStackable || false,
                    isEnabled: data.isEnabled !== false,
                    startDate: data.startDate ? new Date(data.startDate) : new Date(),
                    endDate: data.endDate ? new Date(data.endDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    perUserLimit: data.perUserLimit ? parseInt(data.perUserLimit) : null,
                    globalLimit: data.globalLimit ? parseInt(data.globalLimit) : null,
                },
            });

            ctx.body = { data: offer };
        } catch (error) {
            strapi.log.error('Admin offer create error:', error);
            ctx.throw(500, 'Failed to create offer');
        }
    },

    /**
     * Update an offer
     */
    async update(ctx) {
        try {
            const { id } = ctx.params;
            const { data } = ctx.request.body;

            if (!data) {
                return ctx.badRequest('No data provided');
            }

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
                        `An active "First Recharge" offer already exists: "${existingFirstRecharge.title}" (ID: ${existingFirstRecharge.id}). Disable it first.`
                    );
                }
            }

            // Prevent duplicate coupon codes (excluding self)
            if (data.couponCode && data.couponCode.trim()) {
                const couponCode = data.couponCode.toUpperCase().trim();
                const existingCoupon = await strapi.db.query('api::offer.offer').findOne({
                    where: {
                        couponCode,
                        isEnabled: true,
                        id: { $ne: id },
                    },
                });
                if (existingCoupon) {
                    return ctx.badRequest(
                        `Coupon code "${couponCode}" is already in use by offer "${existingCoupon.title}" (ID: ${existingCoupon.id}).`
                    );
                }
            }

            // Build update data, only include fields that are present
            const updateData = {};
            const fields = [
                'offerType', 'title', 'description', 'bonusType', 'bonusValue',
                'maxBonusCap', 'minRechargeAmount', 'couponCode', 'applicableUserType',
                'priority', 'isStackable', 'isEnabled', 'startDate', 'endDate',
                'perUserLimit', 'globalLimit'
            ];

            fields.forEach(field => {
                if (data[field] !== undefined) {
                    if (['bonusValue', 'maxBonusCap', 'minRechargeAmount'].includes(field)) {
                        updateData[field] = data[field] !== null && data[field] !== '' ? parseFloat(data[field]) : null;
                    } else if (['priority', 'perUserLimit', 'globalLimit'].includes(field)) {
                        updateData[field] = data[field] !== null && data[field] !== '' ? parseInt(data[field]) : null;
                    } else if (['startDate', 'endDate'].includes(field)) {
                        updateData[field] = data[field] ? new Date(data[field]) : null;
                    } else if (field === 'couponCode') {
                        updateData[field] = data[field] ? data[field].toUpperCase().trim() : data[field];
                    } else {
                        updateData[field] = data[field];
                    }
                }
            });

            const offer = await strapi.entityService.update('api::offer.offer', id, {
                data: updateData,
            });

            ctx.body = { data: offer };
        } catch (error) {
            strapi.log.error('Admin offer update error:', error);
            ctx.throw(500, 'Failed to update offer');
        }
    },

    /**
     * Delete an offer
     */
    async delete(ctx) {
        try {
            const { id } = ctx.params;

            // Delete associated usages first
            const usages = await strapi.db.query('api::offer-usage.offer-usage').findMany({
                where: { offer: id },
            });

            for (const usage of usages) {
                await strapi.entityService.delete('api::offer-usage.offer-usage', usage.id);
            }

            // Delete associated conditions
            const conditions = await strapi.db.query('api::offer-condition.offer-condition').findMany({
                where: { offer: id },
            });

            for (const condition of conditions) {
                await strapi.entityService.delete('api::offer-condition.offer-condition', condition.id);
            }

            // Delete the offer
            await strapi.entityService.delete('api::offer.offer', id);

            ctx.body = { message: 'Offer deleted successfully' };
        } catch (error) {
            strapi.log.error('Admin offer delete error:', error);
            ctx.throw(500, 'Failed to delete offer');
        }
    },
};
