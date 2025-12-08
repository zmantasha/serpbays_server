'use strict';

/**
 * Clerk Authentication Controller
 * Handles Clerk user synchronization with Strapi
 */

module.exports = {
    /**
     * Sync Clerk user with Strapi
     * POST /api/auth/clerk/sync
     */
    async sync(ctx) {
        try {
            const { clerkId, email, username, firstName, lastName, advertiser, publisher } = ctx.request.body;

            if (!clerkId || !email) {
                return ctx.badRequest('Missing required fields: clerkId and email');
            }

            strapi.log.info(`Clerk sync request for user: ${email} (${clerkId})`);

            // Find existing user by clerkId or email
            let user = await strapi.query('plugin::users-permissions.user').findOne({
                where: { clerkId },
            });

            if (!user) {
                // Try to find by email
                user = await strapi.query('plugin::users-permissions.user').findOne({
                    where: { email },
                });
            }

            if (user) {
                // Update existing user
                strapi.log.info(`Updating existing user: ${user.id}`);
                user = await strapi.query('plugin::users-permissions.user').update({
                    where: { id: user.id },
                    data: {
                        clerkId,
                        email,
                        username: username || user.username,
                        firstName: firstName || user.firstName,
                        lastName: lastName || user.lastName,
                        confirmed: true,
                    },
                });
            } else {
                // Create new user
                strapi.log.info(`Creating new user for Clerk ID: ${clerkId}`);

                const defaultRole = await strapi.query('plugin::users-permissions.role').findOne({
                    where: { type: 'authenticated' },
                });

                if (!defaultRole) {
                    return ctx.internalServerError('Default role not found');
                }

                user = await strapi.query('plugin::users-permissions.user').create({
                    data: {
                        clerkId,
                        email,
                        username: username || email.split('@')[0],
                        firstName: firstName || '',
                        lastName: lastName || '',
                        confirmed: true,
                        blocked: false,
                        role: defaultRole.id,
                        Advertiser: advertiser || false,
                        Publisher: publisher || false,
                    },
                });

                strapi.log.info(`User created successfully: ${user.id}`);
            }

            // Generate JWT token
            const jwt = strapi.plugins['users-permissions'].services.jwt.issue({
                id: user.id,
            });

            strapi.log.info(`JWT token generated for user: ${user.id}`);

            return ctx.send({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    Advertiser: user.Advertiser,
                    Publisher: user.Publisher,
                },
                jwt,
            });
        } catch (error) {
            strapi.log.error('Clerk sync error:', error);
            return ctx.internalServerError('Failed to sync user with Clerk');
        }
    },

    /**
     * Register new user via Clerk
     * POST /api/auth/register
     */
    async register(ctx) {
        try {
            const { email, username, firstName, lastName, clerkId, advertiser, publisher } = ctx.request.body;

            if (!email || !username) {
                return ctx.badRequest('Missing required fields: email and username');
            }

            strapi.log.info(`Registration request for: ${email}`);

            // Check if user already exists
            const existingUser = await strapi.query('plugin::users-permissions.user').findOne({
                where: { email },
            });

            if (existingUser) {
                strapi.log.warn(`User already exists: ${email}`);
                return ctx.badRequest('User with this email already exists');
            }

            // Get authenticated role
            const defaultRole = await strapi.query('plugin::users-permissions.role').findOne({
                where: { type: 'authenticated' },
            });

            if (!defaultRole) {
                return ctx.internalServerError('Default role not found');
            }

            // Create user
            const user = await strapi.query('plugin::users-permissions.user').create({
                data: {
                    email,
                    username,
                    firstName: firstName || '',
                    lastName: lastName || '',
                    clerkId: clerkId || null,
                    confirmed: true,
                    blocked: false,
                    role: defaultRole.id,
                    Advertiser: advertiser || false,
                    Publisher: publisher || false,
                },
            });

            strapi.log.info(`User registered successfully: ${user.id}`);

            // Generate JWT
            const jwt = strapi.plugins['users-permissions'].services.jwt.issue({
                id: user.id,
            });

            return ctx.send({
                success: true,
                data: {
                    user: {
                        id: user.id,
                        username: user.username,
                        email: user.email,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        Advertiser: user.Advertiser,
                        Publisher: user.Publisher,
                    },
                    jwt,
                },
            });
        } catch (error) {
            strapi.log.error('Registration error:', error);
            return ctx.internalServerError('Failed to register user');
        }
    },
};
