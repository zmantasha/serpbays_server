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
                policies: ['global::is-admin'],
                middlewares: ['global::admin-jwt-auth']
            }
        },

        // Get offer statistics
        {
            method: 'GET',
            path: '/admin/offers/stats',
            handler: 'offers.getStats',
            config: {
                auth: false,
                policies: ['global::is-admin'],
                middlewares: ['global::admin-jwt-auth']
            }
        },

        // Create a new offer
        {
            method: 'POST',
            path: '/admin/offers',
            handler: 'offers.create',
            config: {
                auth: false,
                policies: ['global::is-admin'],
                middlewares: ['global::admin-jwt-auth']
            }
        },

        // Update an offer
        {
            method: 'PUT',
            path: '/admin/offers/:id',
            handler: 'offers.update',
            config: {
                auth: false,
                policies: ['global::is-admin'],
                middlewares: ['global::admin-jwt-auth']
            }
        },

        // Delete an offer
        {
            method: 'DELETE',
            path: '/admin/offers/:id',
            handler: 'offers.delete',
            config: {
                auth: false,
                policies: ['global::is-admin'],
                middlewares: ['global::admin-jwt-auth']
            }
        }
    ]
};
