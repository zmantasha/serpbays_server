'use strict';

/**
 * Offer Engine Service
 * Core logic for validating, calculating, and applying offers during wallet recharge.
 */

module.exports = {
    /**
     * Get all currently applicable offers for a user and amount
     */
    async getApplicableOffers(userId, amount, couponCode = null, currentTransactionId = null) {
        const now = new Date();

        // Fetch all enabled offers within validity period
        const offers = await strapi.db.query('api::offer.offer').findMany({
            where: {
                isEnabled: true,
                startDate: { $lte: now },
                endDate: { $gte: now },
            },
            populate: ['offer_conditions'],
            orderBy: { priority: 'asc' },
        });

        // Filter offers by eligibility
        const applicableOffers = [];
        for (const offer of offers) {
            const validation = await this.validateOffer(offer, userId, amount, couponCode, currentTransactionId);
            if (validation.isValid) {
                const bonus = this.calculateBonus(offer, amount);
                applicableOffers.push({
                    id: offer.id,
                    offerType: offer.offerType,
                    title: offer.title,
                    description: offer.description,
                    bonusType: offer.bonusType,
                    bonusValue: offer.bonusValue,
                    maxBonusCap: offer.maxBonusCap,
                    minRechargeAmount: offer.minRechargeAmount,
                    couponCode: offer.couponCode,
                    isStackable: offer.isStackable,
                    priority: offer.priority,
                    bonusAmount: bonus,
                    requiresCoupon: !!offer.couponCode,
                });
            }
        }

        return applicableOffers;
    },

    /**
     * Validate a single offer against user, amount, and coupon
     */
    async validateOffer(offer, userId, amount, couponCode = null, currentTransactionId = null) {
        const now = new Date();
        const errors = [];

        // 1. Check dates
        if (new Date(offer.startDate) > now) {
            errors.push('Offer not yet active');
        }
        if (new Date(offer.endDate) < now) {
            errors.push('Offer has expired');
        }

        // 2. Check enabled
        if (!offer.isEnabled) {
            errors.push('Offer is disabled');
        }

        // 3. Check minimum recharge amount
        if (offer.minRechargeAmount && amount < offer.minRechargeAmount) {
            errors.push(`Minimum recharge amount is $${offer.minRechargeAmount}`);
        }

        // 4. Check coupon code
        if (offer.couponCode) {
            if (!couponCode || couponCode.toUpperCase() !== offer.couponCode.toUpperCase()) {
                errors.push('Invalid or missing coupon code');
            }
        }

        // 5. Check user type eligibility
        if (offer.applicableUserType !== 'all' && userId) {
            const isNewUser = await this.isNewUser(userId, currentTransactionId);
            if (offer.applicableUserType === 'new' && !isNewUser) {
                errors.push('This offer is for new users only');
            }
            if (offer.applicableUserType === 'existing' && isNewUser) {
                errors.push('This offer is for existing users only');
            }
        }

        // 6. Check per-user limit
        if (offer.perUserLimit && userId) {
            const userUsageCount = await strapi.db.query('api::offer-usage.offer-usage').count({
                where: {
                    offer: offer.id,
                    user: userId,
                },
            });
            if (userUsageCount >= offer.perUserLimit) {
                errors.push('You have already redeemed this offer the maximum number of times');
            }
        }

        // 7. Check global limit
        if (offer.globalLimit) {
            const globalUsageCount = await strapi.db.query('api::offer-usage.offer-usage').count({
                where: { offer: offer.id },
            });
            if (globalUsageCount >= offer.globalLimit) {
                errors.push('This offer has been fully claimed');
            }
        }

        // 8. Check first recharge type
        if (offer.offerType === 'first_recharge' && userId) {
            const depositWhere = {
                users_permissions_user: userId,
                type: 'deposit',
                transactionStatus: 'success',
            };
            // Exclude current transaction from the count (it's already recorded)
            if (currentTransactionId) {
                depositWhere.id = { $ne: currentTransactionId };
            }
            const hasDeposit = await strapi.db.query('api::transaction.transaction').count({
                where: depositWhere,
            });
            console.log(`[OFFER] First recharge check: userId=${userId}, priorDeposits=${hasDeposit}, excludingTx=${currentTransactionId}`);
            if (hasDeposit > 0) {
                errors.push('This offer is only for your first recharge');
            }
        }

        // 9. Evaluate custom conditions
        if (offer.offer_conditions && offer.offer_conditions.length > 0) {
            for (const condition of offer.offer_conditions) {
                const conditionMet = await this.evaluateCondition(condition, userId, amount);
                if (!conditionMet) {
                    errors.push(`Condition not met: ${condition.conditionType}`);
                }
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
        };
    },

    /**
     * Calculate bonus amount for an offer
     */
    calculateBonus(offer, amount) {
        let bonus = 0;

        if (offer.bonusType === 'percentage') {
            bonus = (amount * offer.bonusValue) / 100;
        } else if (offer.bonusType === 'flat') {
            bonus = offer.bonusValue;
        }

        // Apply max bonus cap
        if (offer.maxBonusCap && bonus > offer.maxBonusCap) {
            bonus = offer.maxBonusCap;
        }

        // Round to 2 decimal places
        return Math.round(bonus * 100) / 100;
    },

    /**
     * Apply offers to a recharge — returns the best offer(s) and total bonus
     */
    async applyOffers(userId, amount, couponCode = null, currentTransactionId = null) {
        const applicableOffers = await this.getApplicableOffers(userId, amount, couponCode, currentTransactionId);

        if (applicableOffers.length === 0) {
            return {
                appliedOffers: [],
                totalBonus: 0,
                finalAmount: amount,
            };
        }

        // Sort by priority (lower number = higher priority), then by bonus amount descending
        applicableOffers.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return b.bonusAmount - a.bonusAmount;
        });

        // Check stacking policy
        const allowStacking = await this.isStackingAllowed();
        let appliedOffers = [];
        let totalBonus = 0;

        if (allowStacking) {
            // Apply all stackable offers + the best non-stackable
            const stackable = applicableOffers.filter(o => o.isStackable);
            const nonStackable = applicableOffers.filter(o => !o.isStackable);

            appliedOffers = [...stackable];
            if (nonStackable.length > 0) {
                appliedOffers.push(nonStackable[0]); // Best non-stackable by priority
            }
        } else {
            // Only apply the single best offer
            appliedOffers = [applicableOffers[0]];
        }

        totalBonus = appliedOffers.reduce((sum, o) => sum + o.bonusAmount, 0);

        // Cap total bonus at the recharge amount
        if (totalBonus > amount) {
            totalBonus = amount;
        }

        return {
            appliedOffers,
            totalBonus: Math.round(totalBonus * 100) / 100,
            finalAmount: Math.round((amount + totalBonus) * 100) / 100,
        };
    },

    /**
     * Record offer usage after successful payment
     */
    async recordUsage(offerId, userId, transactionId, bonusAmount, rechargeAmount) {
        try {
            await strapi.entityService.create('api::offer-usage.offer-usage', {
                data: {
                    offer: offerId,
                    user: userId,
                    transactionId: String(transactionId),
                    bonusAmount,
                    rechargeAmount,
                    redeemedAt: new Date(),
                },
            });
            console.log(`[OFFER] ✅ Recorded usage for offer ${offerId}, user ${userId}, bonus $${bonusAmount}`);
            return true;
        } catch (error) {
            console.error(`[OFFER] ❌ Failed to record offer usage:`, error.message);
            return false;
        }
    },

    /**
     * Check if a user is "new" (has never made a successful deposit)
     */
    async isNewUser(userId, currentTransactionId = null) {
        const where = {
            users_permissions_user: userId,
            type: 'deposit',
            transactionStatus: 'success',
        };
        // Exclude the current transaction (already recorded before offer check)
        if (currentTransactionId) {
            where.id = { $ne: currentTransactionId };
        }
        const depositCount = await strapi.db.query('api::transaction.transaction').count({ where });
        console.log(`[OFFER] isNewUser check: userId=${userId}, priorDeposits=${depositCount}, excludingTx=${currentTransactionId}`);
        return depositCount === 0;
    },

    /**
     * Check if offer stacking is allowed (from system config or default)
     */
    async isStackingAllowed() {
        // Default: stacking is NOT allowed (single best offer wins)
        // Can be overridden by adding a global-config entry
        try {
            const config = await strapi.db.query('api::global-config.global-config').findOne({
                where: {},
            });
            if (config && config.metadata && config.metadata.offerStacking !== undefined) {
                return config.metadata.offerStacking;
            }
        } catch (e) {
            // Ignore — config may not exist
        }
        return false;
    },

    /**
     * Evaluate a custom condition
     */
    async evaluateCondition(condition, userId, amount) {
        const { conditionType, operator, value } = condition;

        switch (conditionType) {
            case 'payment_method': {
                // value is an array of allowed payment methods — validated at apply time
                // This is checked at the controller level since we have the payment method there
                return true;
            }

            case 'user_list': {
                // value is an array of user IDs
                const userIds = Array.isArray(value) ? value : [value];
                if (operator === 'in') return userIds.includes(String(userId));
                if (operator === 'not_in') return !userIds.includes(String(userId));
                return true;
            }

            case 'min_total_deposits': {
                // value is a number — user must have deposited at least this much total
                const transactions = await strapi.db.query('api::transaction.transaction').findMany({
                    where: {
                        users_permissions_user: userId,
                        type: 'deposit',
                        transactionStatus: 'success',
                    },
                    select: ['amount'],
                });
                const totalDeposited = transactions.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
                if (operator === 'gte') return totalDeposited >= value;
                if (operator === 'lte') return totalDeposited <= value;
                return true;
            }

            case 'deposit_count': {
                // value is a number — user must have made at least this many deposits
                const count = await strapi.db.query('api::transaction.transaction').count({
                    where: {
                        users_permissions_user: userId,
                        type: 'deposit',
                        transactionStatus: 'success',
                    },
                });
                if (operator === 'gte') return count >= value;
                if (operator === 'lte') return count <= value;
                if (operator === 'equals') return count === value;
                return true;
            }

            default:
                // Unknown condition type — pass by default (extensible)
                console.warn(`[OFFER] Unknown condition type: ${conditionType}`);
                return true;
        }
    },
};
