'use strict';

/**
 * saved-filter controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::saved-filter.saved-filter', ({ strapi }) => ({
    async create(ctx) {
        try {
            // Get the current user
            const user = ctx.state.user;
            if (!user) {
                return ctx.unauthorized('You must be logged in to save filters');
            }

            // Get the data from the request body
            const { name, filterConfig } = ctx.request.body.data;

            // Create the entity with user association
            const entity = await strapi.entityService.create('api::saved-filter.saved-filter', {
                data: {
                    name,
                    filterConfig,
                    users_permissions_user: user.id,
                    publishedAt: new Date()
                }
            });

            return { data: entity };
        } catch (err) {
            ctx.throw(400, err);
        }
    },

    async find(ctx) {
        const user = ctx.state.user;
        if (!user) {
            return ctx.unauthorized('You must be logged in to view saved filters');
        }

        try {
            const entities = await strapi.entityService.findMany('api::saved-filter.saved-filter', {
                filters: {
                    users_permissions_user: user.id
                },
                populate: ['users_permissions_user']
            });

            return { data: entities };
        } catch (err) {
            return ctx.badRequest('Failed to fetch saved filters', { error: err.message });
        }
    },

    async delete(ctx) {
        const user = ctx.state.user;
        if (!user) {
            return ctx.unauthorized('You must be logged in to delete filters');
        }

        try {
            const entity = await strapi.entityService.findOne('api::saved-filter.saved-filter', ctx.params.id, {
                populate: ['users_permissions_user']
            });

            if (!entity) {
                return ctx.notFound('Saved filter not found');
            }

            if (entity.users_permissions_user.id !== user.id) {
                return ctx.forbidden('You can only delete your own saved filters');
            }

            await strapi.entityService.delete('api::saved-filter.saved-filter', ctx.params.id);
            return { data: entity };
        } catch (err) {
            return ctx.badRequest('Failed to delete saved filter', { error: err.message });
        }
    }
})); 