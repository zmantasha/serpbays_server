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

            // Find existing user by clerkId or email (parallel for speed)
            const [userByClerkId, userByEmail] = await Promise.all([
                strapi.query('plugin::users-permissions.user').findOne({
                    where: { clerkId },
                }),
                strapi.query('plugin::users-permissions.user').findOne({
                    where: { email },
                }),
            ]);

            // Prefer clerkId match (authoritative), fallback to email match
            let user = userByClerkId || userByEmail;

            if (user) {
                // Update existing user - only update fields that are provided
                strapi.log.info(`Updating existing user: ${user.id}`);

                // Build update data - only include fields that are actually provided
                const updateData = {
                    clerkId,
                    email,
                    confirmed: true,
                };

                // Only update these fields if they are provided (not undefined)
                if (username !== undefined) updateData.username = username;
                if (firstName !== undefined) updateData.firstName = firstName;
                if (lastName !== undefined) updateData.lastName = lastName;

                // CRITICAL FIX: Do NOT overwrite role fields on existing user sync.
                // Role values are managed by the switch-role API and should persist.
                // Only new users get role values from the sync request.
                // The user's current roles are preserved in the database.
                strapi.log.info(`[CLERK SYNC] NOT overwriting roles for existing user ${user.id}. Current roles: Advertiser=${user.Advertiser}, Publisher=${user.Publisher}`);

                const oldEmail = user.email;

                user = await strapi.query('plugin::users-permissions.user').update({
                    where: { id: user.id },
                    data: updateData,
                });

                // DEBUG: Log email comparison details
                strapi.log.info(`[CLERK SYNC DEBUG] User ID: ${user.id}`);
                strapi.log.info(`[CLERK SYNC DEBUG] Old email (from Strapi before update): "${oldEmail}"`);
                strapi.log.info(`[CLERK SYNC DEBUG] New email (from Clerk request): "${email}"`);
                strapi.log.info(`[CLERK SYNC DEBUG] Emails are different: ${oldEmail !== email}`);

                // If email changed, cascade update to all publisher websites
                if (email && oldEmail !== email) {
                    strapi.log.info(`[CLERK SYNC] Email changed from ${oldEmail} to ${email} - cascading to publisher websites`);

                    // Update publisher_email on marketplace listings owned by this user (by publisher relation)
                    const updatedListings = await strapi.db.query('api::marketplace.marketplace').updateMany({
                        where: { publisher: user.id },
                        data: { publisher_email: email },
                    });
                    strapi.log.info(`[CLERK SYNC] Updated publisher_email on ${updatedListings?.count || 0} marketplace listings (by publisher relation)`);

                    // Also update legacy marketplace listings that match by old email (no publisher relation set)
                    const updatedLegacyListings = await strapi.db.query('api::marketplace.marketplace').updateMany({
                        where: {
                            publisher_email: oldEmail,
                            publisher: null  // Only update orphan records
                        },
                        data: { publisher_email: email },
                    });
                    strapi.log.info(`[CLERK SYNC] Updated publisher_email on ${updatedLegacyListings?.count || 0} legacy marketplace listings (by email)`);

                    // Update publisher-website entries owned by this user (by currentPublisherId relation)
                    const updatedWebsites = await strapi.db.query('api::publisher-website.publisher-website').updateMany({
                        where: { currentPublisherId: user.id },
                        data: { publisherEmail: email },
                    });
                    strapi.log.info(`[CLERK SYNC] Updated publisherEmail on ${updatedWebsites?.count || 0} publisher-websites (by currentPublisherId relation)`);

                    // Also update publisher-websites by originalPublisherId
                    const updatedOriginalWebsites = await strapi.db.query('api::publisher-website.publisher-website').updateMany({
                        where: { originalPublisherId: user.id },
                        data: { publisherEmail: email },
                    });
                    strapi.log.info(`[CLERK SYNC] Updated publisherEmail on ${updatedOriginalWebsites?.count || 0} publisher-websites (by originalPublisherId relation)`);

                    // Also update any publisher-websites that match by old email (for legacy data without relations)
                    const updatedLegacyWebsites = await strapi.db.query('api::publisher-website.publisher-website').updateMany({
                        where: { publisherEmail: oldEmail },
                        data: { publisherEmail: email },
                    });
                    strapi.log.info(`[CLERK SYNC] Updated publisherEmail on ${updatedLegacyWebsites?.count || 0} publisher-websites (by email match)`);
                }
            } else {
                // Create new user
                strapi.log.info(`Creating new user for Clerk ID: ${clerkId}`);

                const defaultRole = await strapi.query('plugin::users-permissions.role').findOne({
                    where: { type: 'authenticated' },
                });

                if (!defaultRole) {
                    return ctx.internalServerError('Default role not found');
                }

                try {
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
                            Advertiser: advertiser ?? true,
                            Publisher: publisher ?? false,
                        },
                    });

                    strapi.log.info(`[CLERK SYNC] User created with roles:`, {
                        userId: user.id,
                        advertiser: advertiser,
                        publisher: publisher,
                        resultAdvertiser: user.Advertiser,
                        resultPublisher: user.Publisher
                    });

                    strapi.log.info(`User created successfully: ${user.id}`);
                } catch (err) {
                    // Handle race condition: if create fails (likely due to unique constraint),
                    // try to find the user again. It might have been created by a parallel request.
                    strapi.log.warn(`[CLERK SYNC] User creation failed, checking if user exists (Race Condition Handler). Error: ${err.message}`);

                    user = await strapi.query('plugin::users-permissions.user').findOne({
                        where: { email },
                    });

                    if (!user) {
                        // If still not found, it's a real error
                        throw err;
                    }
                    strapi.log.info(`[CLERK SYNC] Recovered from race condition, found existing user: ${user.id}`);

                    // Proceed using the found user (effectively treating this as a sync/login)
                }
            }

            // Re-fetch full user to ensure all fields (including isVIP) are present
            user = await strapi.query('plugin::users-permissions.user').findOne({
                where: { id: user.id },
            });

            // Generate JWT token
            const jwt = strapi.plugins['users-permissions'].services.jwt.issue({
                id: user.id,
            });

            strapi.log.info(`JWT token generated for user: ${user.id}`);

            // Return COMPLETE user object with all fields to prevent data loss
            return ctx.send({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    provider: user.provider,
                    confirmed: user.confirmed,
                    blocked: user.blocked,
                    createdAt: user.createdAt,
                    updatedAt: user.updatedAt,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    displayName: user.displayName,
                    country: user.country,
                    phoneNumber: user.phoneNumber,
                    website: user.website,
                    identity: user.identity,
                    businessName: user.businessName,
                    registrationNumber: user.registrationNumber,
                    billingAddress: user.billingAddress,
                    city: user.city,
                    billingCountry: user.billingCountry,
                    pincode: user.pincode,
                    vatGstNumber: user.vatGstNumber,
                    notificationPreferences: user.notificationPreferences,
                    marketplacePreferences: user.marketplacePreferences,
                    Advertiser: user.Advertiser,
                    Publisher: user.Publisher,
                    isVIP: user.isVIP || false,
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
                    Advertiser: advertiser ?? true,
                    Publisher: publisher ?? false,
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
