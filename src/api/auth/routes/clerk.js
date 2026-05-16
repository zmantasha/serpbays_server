'use strict';

/**
 * Clerk authentication routes
 */

module.exports = {
    routes: [
        {
            method: 'POST',
            path: '/auth/clerk/sync',
            handler: 'clerk.sync',
            config: {
                auth: false, // Allow unauthenticated access for initial sync
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'POST',
            path: '/auth/register',
            handler: 'clerk.register',
            config: {
                auth: false, // Allow unauthenticated access for registration
                policies: [],
                middlewares: [],
            },
        },
    ],
};
