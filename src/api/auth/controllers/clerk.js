'use strict';

/**
 * Clerk Authentication Controller
 * Handles Clerk user synchronization with Strapi
 *
 * ARCHITECTURE: All user creation/sync goes through the `sync` method.
 * The `register` method delegates to `sync` to guarantee a single code path.
 * An in-memory mutex prevents race conditions when multiple requests
 * arrive concurrently for the same user (webhook + client-side sync).
 *
 * SECURITY: The `sync` endpoint MUST receive a Clerk-signed session JWT
 * (clerkSessionToken in the request body) and verify it before trusting
 * the claimed clerkId. Without this check, anyone on the internet can
 * POST {clerkId,email} and create a confirmed Strapi user.
 */

const { jwtVerify, createRemoteJWKSet } = require('jose');

// Cached JWKS — built lazily on first request, refreshed automatically by
// jose's createRemoteJWKSet (default cache: 10 min, 5s tolerance for clock skew).
let _jwksCache = null;
let _jwksUrlCache = null;
function getJWKS() {
    const url = process.env.CLERK_JWKS_URL;
    if (!url) throw new Error('CLERK_JWKS_URL env var is not set');
    if (_jwksCache && _jwksUrlCache === url) return _jwksCache;
    _jwksCache = createRemoteJWKSet(new URL(url));
    _jwksUrlCache = url;
    return _jwksCache;
}

/**
 * Verify a Clerk session JWT and return its payload.
 * Throws if missing/invalid/expired/issuer-mismatch.
 */
async function verifyClerkSessionToken(token) {
    if (!token || typeof token !== 'string') {
        throw new Error('Missing or non-string Clerk session token');
    }
    const issuer = process.env.CLERK_JWT_ISSUER;
    const { payload } = await jwtVerify(token, getJWKS(), {
        issuer: issuer || undefined,
        clockTolerance: '5s',
    });
    return payload;
}

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
        const { clerkId, email, username, firstName, lastName, advertiser, publisher, clerkSessionToken, referralCode } = ctx.request.body;

        if (!clerkId || !email) {
            return ctx.badRequest('Missing required fields: clerkId and email');
        }

        // ── SECURITY: verify the caller actually owns the Clerk identity ──
        // Without this, anyone on the internet can POST {clerkId, email} and
        // create a confirmed Strapi user with a valid JWT.
        let verifiedClerkId;
        try {
            const payload = await verifyClerkSessionToken(clerkSessionToken);
            verifiedClerkId = payload.sub;
            if (!verifiedClerkId) throw new Error('Clerk JWT has no sub claim');
        } catch (err) {
            strapi.log.warn(`[CLERK SYNC] Rejected sync from IP ${ctx.request.ip}: ${err.message}`);
            return ctx.unauthorized('Invalid or missing Clerk session token');
        }
        if (verifiedClerkId !== clerkId) {
            strapi.log.warn(`[CLERK SYNC] clerkId mismatch: request=${clerkId} verified=${verifiedClerkId} ip=${ctx.request.ip}`);
            return ctx.unauthorized('clerkId mismatch with verified session token');
        }

        // Acquire a lock keyed by verified clerkId. From here on we trust the
        // verifiedClerkId, NOT the request-supplied clerkId.
        const releaseLock = await acquireLock(`clerk_sync:${verifiedClerkId}`);

        try {
            strapi.log.info(`[CLERK SYNC] Sync request for user: ${email} (${verifiedClerkId})`);

            // Look up by VERIFIED clerkId only. Do NOT fall back to email lookup —
            // that allowed account takeover: attacker with valid Clerk session for
            // their own clerkId could claim victim's email, get matched on email,
            // and overwrite the victim's clerkId.
            let user = await strapi.query('plugin::users-permissions.user').findOne({
                where: { clerkId: verifiedClerkId },
            });

            // For new-account creation, also check email uniqueness. If a
            // different Strapi user already has this email (legacy account
            // without clerkId, or another user), refuse to silently link them.
            if (!user) {
                const userByEmail = await strapi.query('plugin::users-permissions.user').findOne({
                    where: { email },
                });
                if (userByEmail) {
                    strapi.log.warn(`[CLERK SYNC] Email ${email} already in use by user ${userByEmail.id}, refusing to auto-link to clerkId ${verifiedClerkId}`);
                    return ctx.conflict('Email already in use by another account. Contact support to link accounts.');
                }
            }

            if (user) {
                // ── UPDATE existing user ──
                strapi.log.info(`[CLERK SYNC] Found existing user ${user.id}, updating`);

                const updateData = {
                    clerkId: verifiedClerkId,
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
                strapi.log.info(`[CLERK SYNC] No existing user found, creating new user for Clerk ID: ${verifiedClerkId}`);

                const defaultRole = await strapi.query('plugin::users-permissions.role').findOne({
                    where: { type: 'authenticated' },
                });

                if (!defaultRole) {
                    return ctx.internalServerError('Default role not found');
                }

                try {
                    user = await strapi.query('plugin::users-permissions.user').create({
                        data: {
                            clerkId: verifiedClerkId,
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

                    // Fire-and-forget affiliate attribution. Runs only on
                    // fresh account creation (this branch), never on updates.
                    // A referralCode absence, bad code, self-referral, or
                    // any other rejection is silent — signup completes
                    // regardless.
                    if (referralCode) {
                        try {
                            const attributionSvc = require('../../affiliate-profile/services/affiliate-attribution');
                            const signupIp = ctx.request?.ip
                                || (ctx.request?.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
                                || null;
                            await attributionSvc.attributeReferral({
                                userId: user.id,
                                userEmail: email,
                                referralCode,
                                signupIp,
                                userAgent: ctx.request?.headers?.['user-agent'],
                            });
                        } catch (attrErr) {
                            // Don't let attribution failure block the sync
                            // — user must always get a JWT even if the
                            // affiliate side hiccups.
                            strapi.log.warn(`[CLERK SYNC] affiliate attribution failed (non-fatal): ${attrErr.message}`);
                        }
                    }
                } catch (err) {
                    // Safety net: if create fails due to unique constraint (e.g. DB-level race),
                    // find the existing user instead of failing.
                    strapi.log.warn(`[CLERK SYNC] User creation failed (likely unique constraint). Recovering. Error: ${err.message}`);

                    user = await strapi.query('plugin::users-permissions.user').findOne({
                        where: { $or: [{ clerkId: verifiedClerkId }, { email }] },
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
        const { email, username, firstName, lastName, clerkId, advertiser, publisher, clerkSessionToken } = ctx.request.body;

        if (!email) {
            return ctx.badRequest('Missing required field: email');
        }

        // Normalize the request body to match sync's expected format, then delegate.
        // clerkSessionToken is forwarded so sync()'s verification step still runs.
        ctx.request.body = {
            clerkId: clerkId || null,
            email,
            username: username || email.split('@')[0],
            firstName: firstName || '',
            lastName: lastName || '',
            advertiser: advertiser ?? true,
            publisher: publisher ?? false,
            clerkSessionToken,
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
