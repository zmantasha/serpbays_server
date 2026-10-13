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
const { sendEvent, browserContextFromCtx } = require('../../../utils/meta-capi');

// ── Meta ads attribution (2026-09-28) ──────────────────────────────────────
// The customer app sends `attribution` (first/last-touch campaign params read
// from the sb_ft / sb_lt cookies on .serpbays.com) and `fb` ({fbp, fbc, url})
// with every sync. We keep first-touch campaign data on the user, refresh the
// browser identifiers used by server-side CAPI events, and fire the
// registration event once, server-side, so Google sign-ups are counted too.
const ATTRIBUTION_KEYS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
    'fbclid', 'gclid', 'ref', 'landing', 'referrer', 'ts',
];
// A user this young with no registration event yet is treated as a new
// signup even if another sync call (e.g. the Clerk webhook) created the row.
const NEW_USER_WINDOW_MS = 60 * 60 * 1000;

function cleanTouch(touch) {
    if (!touch || typeof touch !== 'object') return null;
    const out = {};
    for (const k of ATTRIBUTION_KEYS) {
        const v = touch[k];
        if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 500);
        else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
}

// 2026-10-14: campaign attribution is stored for every new signup, with or
// without the Meta pixel context (ad blockers), and the affiliate referral is
// resolved from it. The Meta registration event itself still needs `fb`.
async function recordSignupAttribution(ctx, user, { createdHere, attribution }) {
    const ageMs = user.createdAt ? Date.now() - new Date(user.createdAt).getTime() : Infinity;
    const isNewSignup = createdHere || ageMs < NEW_USER_WINDOW_MS;
    const existing = user.signupAttribution || null;
    if (isNewSignup && !(existing && (existing.first || existing.last))) {
        const first = cleanTouch(attribution && attribution.first);
        const last = cleanTouch(attribution && attribution.last);
        if (first || last) {
            user.signupAttribution = { ...(existing || {}), first, last, capturedAt: (existing && existing.capturedAt) || new Date().toISOString() };
            await strapi.query('plugin::users-permissions.user').update({ where: { id: user.id }, data: { signupAttribution: user.signupAttribution } });
        }
    }
    try {
        const aff = require('../../../services/affiliate');
        if (aff && aff.resolveReferral) {
            await aff.resolveReferral(user, { attribution, isNewSignup, ip: requestGeo(ctx).ip || ctx.request.ip, userAgent: ctx.request.headers['user-agent'] });
        }
    } catch (e) {
        if (!e || e.code !== 'MODULE_NOT_FOUND') strapi.log.warn(`[CLERK SYNC] referral skipped for user ${user.id}: ${e && e.message}`);
    }
}

async function recordAdAttribution(ctx, user, { createdHere, attribution, fb }) {
    // Only the browser sends `fb`; server-to-server sync calls (webhook) have
    // no useful ip/ua and must not fire the registration event.
    if (!fb || typeof fb !== 'object') return;

    const patch = { fbBrowserContext: browserContextFromCtx(ctx, fb) };
    const ageMs = user.createdAt ? Date.now() - new Date(user.createdAt).getTime() : Infinity;
    const isNewSignup = createdHere || ageMs < NEW_USER_WINDOW_MS;
    const existing = user.signupAttribution || null;

    let fireRegistration = false;
    if (isNewSignup && !(existing && existing.metaRegSentAt)) {
        patch.signupAttribution = {
            first: (existing && existing.first) || cleanTouch(attribution && attribution.first),
            last: (existing && existing.last) || cleanTouch(attribution && attribution.last),
            capturedAt: (existing && existing.capturedAt) || new Date().toISOString(),
            metaRegSentAt: new Date().toISOString(),
        };
        fireRegistration = true;
    }

    await strapi.query('plugin::users-permissions.user').update({
        where: { id: user.id },
        data: patch,
    });

    if (!fireRegistration) return;
    const isPublisherOnly = user.Publisher && !user.Advertiser;
    const eventSourceUrl = typeof fb.url === 'string' && fb.url.length <= 1000 ? fb.url : 'https://app.serpbays.com/register';
    setImmediate(() => {
        sendEvent({
            eventName: isPublisherOnly ? 'PublisherSignup' : 'CompleteRegistration',
            eventId: `reg-${user.id}`,
            eventTime: user.createdAt || Date.now(),
            eventSourceUrl,
            user,
            browser: patch.fbBrowserContext,
            customData: {
                status: 'completed',
                registration_method: 'clerk',
                content_category: isPublisherOnly ? 'publisher' : 'advertiser',
            },
        });
    });
}

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
/**
 * Country + IP of the person calling sync. Cloudflare adds CF-IPCountry on
 * every proxied request; the customer app may also forward the browser's
 * value as X-User-Country when it calls sync server-side. "XX"/"T1" mean
 * unknown / Tor.
 */
function requestGeo(ctx) {
    const h = ctx.request.headers || {};
    const raw = String(h['x-user-country'] || h['cf-ipcountry'] || '').trim().toUpperCase();
    const country = /^[A-Z]{2}$/.test(raw) && raw !== 'XX' && raw !== 'T1' ? raw : null;
    const ip = String(h['x-user-ip'] || h['cf-connecting-ip'] || h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || ctx.request.ip || '').trim().slice(0, 64) || null;
    return { country, ip };
}

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
        const { clerkId, email, username, firstName, lastName, advertiser, publisher, clerkSessionToken, attribution, fb } = ctx.request.body;
        let createdHere = false;

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
            strapi.log.warn(`[CLERK SYNC] Rejected sync from IP ${ctx.request.ip} geo=${JSON.stringify(requestGeo(ctx))}: ${err.message}`);
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
            const geo = requestGeo(ctx);
            strapi.log.info(`[CLERK SYNC] Sync request for user: ${email} (${verifiedClerkId}) geo=${geo.country || '-'}`);

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
                            signupCountry: geo.country,
                            signupIp: geo.ip,
                            lastLoginCountry: geo.country,
                            lastLoginAt: new Date(),
                        },
                    });

                    createdHere = true;
                    strapi.log.info(`[CLERK SYNC] User created successfully: ${user.id} (Advertiser=${user.Advertiser}, Publisher=${user.Publisher})`);
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

            // Ownership backfill (2026-09-24). Websites added on this
            // publisher's behalf before they had an account carry only their
            // email. Link them now (existing-user, new-user and recovery
            // branches all land here) so publisher-website.find() can use a
            // single indexed owner lookup instead of an email OR per page
            // load. Non-fatal: a failure here must never block login.
            try {
                await strapi.service('api::publisher-website.publisher-website')
                    .linkOwnerlessWebsitesByEmail(user.id, user.email);
            } catch (linkErr) {
                strapi.log.warn(`[CLERK SYNC] ownerless-website link skipped for user ${user.id}: ${linkErr.message}`);
            }

            // Generate JWT token
            // Record where this login came from (fills signupCountry for legacy users on their next login).
            try {
                const patch = { lastLoginAt: new Date() };
                if (geo.country) { patch.lastLoginCountry = geo.country; if (!user.signupCountry) patch.signupCountry = geo.country; }
                if (geo.ip && !user.signupIp) patch.signupIp = geo.ip;
                await strapi.query('plugin::users-permissions.user').update({ where: { id: user.id }, data: patch });
            } catch (geoErr) {
                strapi.log.warn(`[CLERK SYNC] geo update failed for user ${user.id}: ${geoErr.message}`);
            }

            // Meta ads: campaign attribution + server-side registration event.
            // Non-fatal — never block login on this.
            try {
                await recordSignupAttribution(ctx, user, { createdHere, attribution });
                await recordAdAttribution(ctx, user, { createdHere, attribution, fb });
            } catch (adErr) {
                strapi.log.warn(`[CLERK SYNC] ad attribution skipped for user ${user.id}: ${adErr.message}`);
            }

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
        const { email, username, firstName, lastName, clerkId, advertiser, publisher, clerkSessionToken, attribution, fb } = ctx.request.body;

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
            attribution,
            fb,
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
