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
                fields: ['id', 'documentId', 'name', 'filterConfig', 'createdAt', 'updatedAt'],
                // populate intentionally OMITTED — users_permissions_user is a
                // full up_users row that would leak password hash / OTPs / PII.
            });

            return { data: entities };
        } catch (err) {
            strapi.log?.error?.('[saved-filter] find failed', { error: err.message });
            return ctx.badRequest('Failed to fetch saved filters');
        }
    },

    async findOne(ctx) {
        const user = ctx.state.user;
        if (!user) {
            return ctx.unauthorized('You must be logged in to view this saved filter');
        }
        const numericId = Number(ctx.params.id);
        if (!Number.isInteger(numericId) || numericId <= 0) {
            return ctx.notFound('Saved filter not found');
        }
        const record = await strapi.db.query('api::saved-filter.saved-filter').findOne({
            where: { id: numericId },
            populate: { users_permissions_user: { select: ['id'] } },
        });
        if (!record) return ctx.notFound('Saved filter not found');
        if (record.users_permissions_user?.id !== user.id) {
            return ctx.notFound('Saved filter not found');
        }
        return {
            data: {
                id: record.id,
                documentId: record.documentId,
                name: record.name,
                filterConfig: record.filterConfig,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
            },
        };
    },

    async update(ctx) {
        const user = ctx.state.user;
        if (!user) {
            return ctx.unauthorized('You must be logged in to update this saved filter');
        }
        const numericId = Number(ctx.params.id);
        if (!Number.isInteger(numericId) || numericId <= 0) {
            return ctx.notFound('Saved filter not found');
        }
        const existing = await strapi.db.query('api::saved-filter.saved-filter').findOne({
            where: { id: numericId },
            populate: { users_permissions_user: { select: ['id'] } },
        });
        if (!existing) return ctx.notFound('Saved filter not found');
        if (existing.users_permissions_user?.id !== user.id) {
            return ctx.notFound('Saved filter not found');
        }
        const body = ctx.request.body?.data || ctx.request.body || {};
        const allowed = {};
        if (typeof body.name === 'string') {
            const n = body.name.trim();
            if (n.length === 0 || n.length > 200) return ctx.badRequest('name must be 1..200 chars');
            allowed.name = n;
        }
        if (body.filterConfig !== undefined) {
            if (typeof body.filterConfig !== 'object' || body.filterConfig === null) {
                return ctx.badRequest('filterConfig must be an object');
            }
            allowed.filterConfig = body.filterConfig;
        }
        if (Object.keys(allowed).length === 0) {
            return ctx.badRequest('No mutable fields supplied');
        }
        const updated = await strapi.entityService.update(
            'api::saved-filter.saved-filter',
            numericId,
            { data: allowed, fields: ['id', 'documentId', 'name', 'filterConfig', 'createdAt', 'updatedAt'] }
        );
        return { data: updated };
    },

    async delete(ctx) {
        const user = ctx.state.user;
        if (!user) {
            return ctx.unauthorized('You must be logged in to delete filters');
        }

        try {
            const entity = await strapi.db.query('api::saved-filter.saved-filter').findOne({
                where: { id: ctx.params.id },
                populate: { users_permissions_user: { select: ['id'] } },
            });

            if (!entity) {
                return ctx.notFound('Saved filter not found');
            }

            if (entity.users_permissions_user?.id !== user.id) {
                // 404 not 403 — defeat enumeration.
                return ctx.notFound('Saved filter not found');
            }

            await strapi.entityService.delete('api::saved-filter.saved-filter', ctx.params.id);
            return { data: { id: ctx.params.id } };
        } catch (err) {
            strapi.log?.error?.('[saved-filter] delete failed', { error: err.message });
            return ctx.badRequest('Failed to delete saved filter');
        }
    }
})); 