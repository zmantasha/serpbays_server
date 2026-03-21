'use strict';

/**
 * Clerk Authentication Controller
 * Handles Clerk user synchronization with Strapi
 *
 * ARCHITECTURE: All user creation/sync goes through the `sync` method.
 * The `register` method delegates to `sync` to guarantee a single code path.
 * An in-memory mutex prevents race conditions when multiple requests
 * arrive concurrently for the same user (webhook + client-side sync).
 */

// In-memory mutex to prevent concurrent user creation for the same clerkId/email.
// Maps a lock key (clerkId or email) to a Promise that resolves when the lock is released.
const _locks = new Map();

/**
 * Acquire a mutex lock for a given key. If another request already holds the lock,
 * this will wait until it completes before proceeding.
 * Returns a release function that MUST be called when done.
 */
async function acquireLock(key) {
    while (_locks.has(key)) {
        // Wait for the existing lock to be released
        await _locks.get(key);
    }
    let releaseLock;
    const lockPromise = new Promise((resolve) => {
        releaseLock = resolve;
    });
    _locks.set(key, lockPromise);
    return () => {
        _locks.delete(key);
        releaseLock();
    };
}

module.exports = {
    /**
     * Sync Clerk user with Strapi (idempotent find-or-create)
     * POST /api/auth/clerk/sync
     *
     * This is the SINGLE SOURCE OF TRUTH for user creation.
     * It is safe to call multiple times — duplicate calls are serialized
     * via an in-memory mutex and the DB unique constraint is a safety net.
     */
    async sync(ctx) {
        const { clerkId, email, username, firstName, lastName, advertiser, publisher } = ctx.request.body;

        if (!clerkId || !email) {
            return ctx.badRequest('Missing required fields: clerkId and email');
        }

        // Acquire a lock keyed by clerkId to serialize concurrent requests for the same user.
        // This prevents the race condition where two requests both see "user not found"
        // and both proceed to create, resulting in duplicates.
        const releaseLock = await acquireLock(`clerk_sync:${clerkId}`);

        try {
            strapi.log.info(`[CLERK SYNC] Sync request for user: ${email} (${clerkId})`);

            // Step 1: Find existing user by clerkId (primary key for Clerk users)
            let user = await strapi.query('plugin::users-permissions.user').findOne({
                where: { clerkId },
            });

            // Step 2: If not found by clerkId, try email (handles pre-existing users)
            if (!user) {
                user = await strapi.query('plugin::users-permissions.user').findOne({
                    where: { email },
                });
            }

            if (user) {
                // ── UPDATE existing user ──
                strapi.log.info(`[CLERK SYNC] Found existing user ${user.id}, updating`);

                const updateData = {
                    clerkId,
                    email,
                    confirmed: true,
                };

                // Only update fields that are provided (not undefined)
                if (username !== undefined) updateData.username = username;
                if (firstName !== undefined) updateData.firstName = firstName;
                if (lastName !== undefined) updateData.lastName = lastName;

                // CRITICAL: Do NOT overwrite role fields on existing user sync.
                // Roles are managed by the switch-role API and must persist.
                strapi.log.info(`[CLERK SYNC] NOT overwriting roles for existing user ${user.id}. Current roles: Advertiser=${user.Advertiser}, Publisher=${user.Publisher}`);

                const oldEmail = user.email;

                user = await strapi.query('plugin::users-permissions.user').update({
                    where: { id: user.id },
                    data: updateData,
                });

                // If email changed, cascade update to all publisher websites
                if (email && oldEmail !== email) {
                    strapi.log.info(`[CLERK SYNC] Email changed from ${oldEmail} to ${email} - cascading to publisher websites`);

                    await strapi.db.query('api::marketplace.marketplace').updateMany({
                        where: { publisher: user.id },
                        data: { publisher_email: email },
                    });

                    await strapi.db.query('api::marketplace.marketplace').updateMany({
                        where: {
                            publisher_email: oldEmail,
                            publisher: null,
                        },
                        data: { publisher_email: email },
                    });

                    await strapi.db.query('api::publisher-website.publisher-website').updateMany({
                        where: { currentPublisherId: user.id },
                        data: { publisherEmail: email },
                    });

                    await strapi.db.query('api::publisher-website.publisher-website').updateMany({
                        where: { originalPublisherId: user.id },
                        data: { publisherEmail: email },
                    });

                    await strapi.db.query('api::publisher-website.publisher-website').updateMany({
                        where: { publisherEmail: oldEmail },
                        data: { publisherEmail: email },
                    });
                }
            } else {
                // ── CREATE new user ──
                strapi.log.info(`[CLERK SYNC] No existing user found, creating new user for Clerk ID: ${clerkId}`);

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

                    strapi.log.info(`[CLERK SYNC] User created successfully: ${user.id} (Advertiser=${user.Advertiser}, Publisher=${user.Publisher})`);
                } catch (err) {
                    // Safety net: if create fails due to unique constraint (e.g. DB-level race),
                    // find the existing user instead of failing.
                    strapi.log.warn(`[CLERK SYNC] User creation failed (likely unique constraint). Recovering. Error: ${err.message}`);

                    user = await strapi.query('plugin::users-permissions.user').findOne({
                        where: { $or: [{ clerkId }, { email }] },
                    });

                    if (!user) {
                        throw err;
                    }
                    strapi.log.info(`[CLERK SYNC] Recovered from constraint conflict, found existing user: ${user.id}`);
                }
            }

            // Generate JWT token
            const jwt = strapi.plugins['users-permissions'].services.jwt.issue({
                id: user.id,
            });

            strapi.log.info(`[CLERK SYNC] JWT generated for user: ${user.id}`);

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
                },
                jwt,
            });
        } catch (error) {
            strapi.log.error('[CLERK SYNC] Sync error:', error);
            return ctx.internalServerError('Failed to sync user with Clerk');
        } finally {
            // ALWAYS release the lock, even on error
            releaseLock();
        }
    },

    /**
     * Register new user via Clerk
     * POST /api/auth/register
     *
     * Delegates to the `sync` method to ensure a single code path for user creation.
     * This prevents the race condition where webhook calls /register while
     * client-side calls /sync, with each using different logic.
     */
    async register(ctx) {
        const { email, username, firstName, lastName, clerkId, advertiser, publisher } = ctx.request.body;

        if (!email) {
            return ctx.badRequest('Missing required field: email');
        }

        // Normalize the request body to match sync's expected format, then delegate.
        ctx.request.body = {
            clerkId: clerkId || null,
            email,
            username: username || email.split('@')[0],
            firstName: firstName || '',
            lastName: lastName || '',
            advertiser: advertiser ?? true,
            publisher: publisher ?? false,
        };

        // If no clerkId provided, we can't use the mutex effectively,
        // but sync will still do a find-by-email check.
        if (!ctx.request.body.clerkId) {
            // Generate a temporary clerkId placeholder so sync doesn't reject it.
            // The webhook should always provide a real clerkId.
            strapi.log.warn(`[CLERK REGISTER] No clerkId provided for ${email}, registration may be incomplete`);
            return ctx.badRequest('Missing required field: clerkId');
        }

        strapi.log.info(`[CLERK REGISTER] Delegating to sync for: ${email} (${clerkId})`);
        return this.sync(ctx);
    },
};
