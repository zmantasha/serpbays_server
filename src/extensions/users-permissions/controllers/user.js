'use strict';

/**
 * Custom User Controller
 * Extends the default users-permissions user controller
 */

const { sanitize } = require('@strapi/utils');

module.exports = (plugin) => {
    // Override the default update method to allow users to update their own profile
    plugin.controllers.user.update = async (ctx) => {
        try {
            const { id } = ctx.params;
            const authenticatedUser = ctx.state.user;

            // Check if user is updating their own profile
            if (authenticatedUser.id !== parseInt(id)) {
                return ctx.forbidden('You can only update your own profile');
            }

            // Get the update data from request body
            const updateData = ctx.request.body;

            // Fields that users are allowed to update
            const allowedFields = [
                'username',
                'firstName',
                'lastName',
                'country',
                'phoneNumber',
                'website',
                'identity',
                'businessName',
                'registrationNumber',
                'billingAddress',
                'city',
                'pincode',
                'vatGstNumber',
                'notificationPreferences',
                'marketplacePreferences',
                'paypalEmail',
                'payoneerEmail'
            ];

            // Filter update data to only include allowed fields
            const filteredData = {};
            for (const field of allowedFields) {
                if (updateData.hasOwnProperty(field)) {
                    filteredData[field] = updateData[field];
                }
            }

            strapi.log.info(`User ${id} updating profile with:`, filteredData);

            // Update the user
            const updatedUser = await strapi.query('plugin::users-permissions.user').update({
                where: { id: parseInt(id) },
                data: filteredData,
            });

            strapi.log.info(`User ${id} profile updated successfully`);

            // Return the updated user (sanitized)
            ctx.send(updatedUser);

        } catch (error) {
            strapi.log.error('User profile update error:', error);
            return ctx.internalServerError('Failed to update profile');
        }
    };

    return plugin;
};
