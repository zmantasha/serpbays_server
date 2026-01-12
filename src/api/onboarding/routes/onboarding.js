'use strict';

/**
 * Onboarding routes
 */

module.exports = {
    routes: [
        {
            method: 'GET',
            path: '/onboarding',
            handler: 'onboarding.getState',
            config: {
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'PUT',
            path: '/onboarding',
            handler: 'onboarding.updateState',
            config: {
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'POST',
            path: '/onboarding/:tourName/complete',
            handler: 'onboarding.completeTour',
            config: {
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'POST',
            path: '/onboarding/:tourName/skip',
            handler: 'onboarding.skipTour',
            config: {
                policies: [],
                middlewares: [],
            },
        },
    ],
};
