'use strict';

/**
 * Onboarding controller
 * Handles onboarding state management for authenticated users
 */

module.exports = {
    /**
     * Get current user's onboarding state
     * GET /api/onboarding
     */
    async getState(ctx) {
        try {
            const userId = ctx.state.user?.id;

            if (!userId) {
                return ctx.unauthorized('You must be logged in');
            }

            const user = await strapi.entityService.findOne(
                'plugin::users-permissions.user',
                userId,
                { fields: ['onboardingState'] }
            );

            ctx.send({
                data: user?.onboardingState || {}
            });
        } catch (error) {
            strapi.log.error('Error fetching onboarding state:', error);
            ctx.badRequest('Failed to fetch onboarding state');
        }
    },

    /**
     * Update user's onboarding state
     * PUT /api/onboarding
     */
    async updateState(ctx) {
        try {
            const userId = ctx.state.user?.id;

            if (!userId) {
                return ctx.unauthorized('You must be logged in');
            }

            const { body } = ctx.request;

            // Validate that body contains onboarding state
            if (!body || typeof body !== 'object') {
                return ctx.badRequest('Invalid onboarding state data');
            }

            // Get current state
            const user = await strapi.entityService.findOne(
                'plugin::users-permissions.user',
                userId,
                { fields: ['onboardingState'] }
            );

            // Merge with new state
            const updatedState = {
                ...(user?.onboardingState || {}),
                ...body
            };

            // Update user
            const updatedUser = await strapi.entityService.update(
                'plugin::users-permissions.user',
                userId,
                {
                    data: { onboardingState: updatedState }
                }
            );

            ctx.send({
                data: updatedUser.onboardingState
            });
        } catch (error) {
            strapi.log.error('Error updating onboarding state:', error);
            ctx.badRequest('Failed to update onboarding state');
        }
    },

    /**
     * Mark a specific tour as completed
     * POST /api/onboarding/:tourName/complete
     */
    async completeTour(ctx) {
        try {
            const userId = ctx.state.user?.id;
            const { tourName } = ctx.params;

            if (!userId) {
                return ctx.unauthorized('You must be logged in');
            }

            if (!tourName) {
                return ctx.badRequest('Tour name is required');
            }

            // Get current state
            const user = await strapi.entityService.findOne(
                'plugin::users-permissions.user',
                userId,
                { fields: ['onboardingState'] }
            );

            // Update specific tour
            const updatedState = {
                ...(user?.onboardingState || {}),
                [tourName]: {
                    completed: true,
                    skipped: false,
                    completedAt: new Date().toISOString()
                }
            };

            // Save to database
            await strapi.entityService.update(
                'plugin::users-permissions.user',
                userId,
                {
                    data: { onboardingState: updatedState }
                }
            );

            ctx.send({
                success: true,
                data: updatedState[tourName]
            });
        } catch (error) {
            strapi.log.error(`Error completing tour ${ctx.params.tourName}:`, error);
            ctx.badRequest('Failed to complete tour');
        }
    },

    /**
     * Mark a specific tour as skipped
     * POST /api/onboarding/:tourName/skip
     */
    async skipTour(ctx) {
        try {
            const userId = ctx.state.user?.id;
            const { tourName } = ctx.params;

            if (!userId) {
                return ctx.unauthorized('You must be logged in');
            }

            if (!tourName) {
                return ctx.badRequest('Tour name is required');
            }

            // Get current state
            const user = await strapi.entityService.findOne(
                'plugin::users-permissions.user',
                userId,
                { fields: ['onboardingState'] }
            );

            // Update specific tour
            const updatedState = {
                ...(user?.onboardingState || {}),
                [tourName]: {
                    completed: false,
                    skipped: true,
                    completedAt: new Date().toISOString()
                }
            };

            // Save to database
            await strapi.entityService.update(
                'plugin::users-permissions.user',
                userId,
                {
                    data: { onboardingState: updatedState }
                }
            );

            ctx.send({
                success: true,
                data: updatedState[tourName]
            });
        } catch (error) {
            strapi.log.error(`Error skipping tour ${ctx.params.tourName}:`, error);
            ctx.badRequest('Failed to skip tour');
        }
    }
};
