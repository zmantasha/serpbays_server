'use strict';

/**
 * Admin Offers Routes
 * Routes for managing offers from admin panel
 */

module.exports = {
    routes: [
        // Get all offers with filtering and pagination
        {
            method: 'GET',
            path: '/admin/offers',
            handler: 'offers.find',
            config: {
                auth: false,
                policies: [],
                middlewares: []
            }
        },

        // Get offer statistics
        {
            method: 'GET',
            path: '/admin/offers/stats',
            handler: 'offers.getStats',
            config: {
                auth: false,
                policies: [],
                middlewares: []
            }
        },

        // Create a new offer
        {
            method: 'POST',
            path: '/admin/offers',
            handler: 'offers.create',
            config: {
                auth: false,
                policies: [],
                middlewares: []
            }
        },

        // Update an offer
        {
            method: 'PUT',
            path: '/admin/offers/:id',
            handler: 'offers.update',
            config: {
                auth: false,
                policies: [],
                middlewares: []
            }
        },

        // Delete an offer
        {
            method: 'DELETE',
            path: '/admin/offers/:id',
            handler: 'offers.delete',
            config: {
                auth: false,
                policies: [],
                middlewares: []
            }
        }
    ]
};
