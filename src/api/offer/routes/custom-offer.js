'use strict';

/**
 * Custom offer routes for user-facing and admin endpoints
 */

module.exports = {
    routes: [
        {
            method: 'GET',
            path: '/offers/applicable',
            handler: 'offer.getApplicableOffers',
            config: {
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'POST',
            path: '/offers/apply',
            handler: 'offer.applyOffers',
            config: {
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'POST',
            path: '/offers/validate-coupon',
            handler: 'offer.validateCoupon',
            config: {
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'GET',
            path: '/offers/stats',
            handler: 'offer.getStats',
            config: {
                policies: [],
                middlewares: [],
            },
        },
    ],
};
