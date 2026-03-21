'use strict';

/**
 * AI Content Generation Routes
 */

module.exports = {
    routes: [
        {
            method: 'POST',
            path: '/ai-content/generate',
            handler: 'ai-content.generate',
            config: {
                auth: false,
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'POST',
            path: '/ai-content/generate-meta',
            handler: 'ai-content.generateMeta',
            config: {
                auth: false,
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'GET',
            path: '/ai-content/status',
            handler: 'ai-content.status',
            config: {
                auth: false,
                policies: [],
                middlewares: [],
            },
        },
    ],
};
