'use strict';

/**
 * Onboarding service
 * Business logic for onboarding operations
 */

module.exports = () => ({
    /**
     * Validate tour name
     */
    isValidTourName(tourName) {
        const validTours = ['marketplace', 'publisher', 'advertiser'];
        return validTours.includes(tourName);
    },

    /**
     * Get user's onboarding state
     */
    async getUserState(userId) {
        const user = await strapi.entityService.findOne(
            'plugin::users-permissions.user',
            userId,
            { fields: ['onboardingState'] }
        );

        return user?.onboardingState || {};
    },

    /**
     * Update user's onboarding state
     */
    async updateUserState(userId, newState) {
        const currentState = await this.getUserState(userId);

        const mergedState = {
            ...currentState,
            ...newState
        };

        const updatedUser = await strapi.entityService.update(
            'plugin::users-permissions.user',
            userId,
            {
                data: { onboardingState: mergedState }
            }
        );

        return updatedUser.onboardingState;
    },

    /**
     * Mark tour as completed
     */
    async completeTour(userId, tourName) {
        if (!this.isValidTourName(tourName)) {
            throw new Error(`Invalid tour name: ${tourName}`);
        }

        const currentState = await this.getUserState(userId);

        const updatedState = {
            ...currentState,
            [tourName]: {
                completed: true,
                skipped: false,
                completedAt: new Date().toISOString()
            }
        };

        return await this.updateUserState(userId, updatedState);
    },

    /**
     * Mark tour as skipped
     */
    async skipTour(userId, tourName) {
        if (!this.isValidTourName(tourName)) {
            throw new Error(`Invalid tour name: ${tourName}`);
        }

        const currentState = await this.getUserState(userId);

        const updatedState = {
            ...currentState,
            [tourName]: {
                completed: false,
                skipped: true,
                completedAt: new Date().toISOString()
            }
        };

        return await this.updateUserState(userId, updatedState);
    }
});
