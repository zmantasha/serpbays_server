'use strict';

// =============================================================================
// JWT token-version revocation helpers
// =============================================================================
// Audit finding #11 stage 1. Every issued Strapi JWT embeds the user's
// current tokenVersion. The verify() override rejects any JWT whose claim
// tokenVersion is < the user's current value, regardless of JWT TTL.
//
// JWT expiry stays 7 days (config/plugins.js). This is the revocation knob:
// bumping tokenVersion on the user row invalidates every JWT issued before
// the bump.
//
// Triggers that bump:
//   - POST /api/auth/logout                  → +1 (this user)
//   - POST /api/auth/revoke/:id              → +1 (admin-only, target user)
//   - User update with role/blocked changing → +1 (via beforeUpdate lifecycle)
//   - users-permissions changePassword path  → +1 (via auth controller extension)
//
// Backward compatibility: old JWTs minted before this column existed have no
// tokenVersion claim. We treat missing as 0, and the column defaults to 0,
// so existing sessions stay valid until a trigger fires for that user.
//
// Sync NOTE: this changes services.jwt.issue() from sync to async because we
// need a DB read to grab the current tokenVersion. The two call sites
// (clerk.js, admin/admin.js) are updated to await.
// =============================================================================

const lookupTokenVersion = async (strapi, userId) => {
  if (userId == null) return 0;
  try {
    const u = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { id: userId },
      select: ['id', 'tokenVersion'],
    });
    return u ? (u.tokenVersion ?? 0) : 0;
  } catch (e) {
    // Failing the lookup must NOT lock out a legitimate user — fall back to
    // 0 and log. The signed value being 0 still matches the default DB row
    // value for unbumped users.
    strapi.log.warn(`[jwt.tokenVersion] lookup failed for user ${userId}: ${e && e.message}`);
    return 0;
  }
};

const bumpTokenVersion = async (strapi, userId, reason) => {
  if (userId == null) return;
  try {
    // Atomic increment via knex so concurrent bumps don't race.
    await strapi.db.connection('up_users').where({ id: userId }).increment('token_version', 1);
    strapi.log.info(`[jwt.tokenVersion] bumped user=${userId} reason=${reason || 'unspecified'}`);
  } catch (e) {
    strapi.log.error(`[jwt.tokenVersion] bump failed for user ${userId}: ${e && e.message}`);
    throw e;
  }
};

module.exports = (plugin) => {
  // Get the original controller
  const sanitizeOutput = (user) => {
    const {
      password, resetPasswordToken, confirmationToken,
      ...sanitizedUser
    } = user;
    return sanitizedUser;
  };

  // Helper: refuse to delete a user who still owns marketplaces.
  // Resolves the delete query's `where` clause to concrete user IDs, counts
  // marketplaces per user via the junction table, and throws a clean error
  // if any are blocking. No-op if the where clause matches no users or none
  // of the resolved users own marketplaces.
  const blockUserDeleteIfOwnsMarketplaces = async (where) => {
    const users = await strapi.db.query('plugin::users-permissions.user').findMany({
      where,
      select: ['id', 'email'],
    });
    if (users.length === 0) return;

    const userIds = users.map((u) => u.id);
    const owned = await strapi.db.connection('marketplaces_publisher_lnk')
      .whereIn('user_id', userIds)
      .select('user_id');
    if (owned.length === 0) return;

    const countByUser = {};
    for (const row of owned) countByUser[row.user_id] = (countByUser[row.user_id] || 0) + 1;

    const blocking = users
      .filter((u) => countByUser[u.id])
      .map((u) => `${u.email} (${countByUser[u.id]} marketplace${countByUser[u.id] === 1 ? '' : 's'})`)
      .join('; ');

    throw new Error(
      `Cannot delete user — they own marketplaces: ${blocking}. ` +
      `Reassign or archive these marketplaces before deleting the user.`
    );
  };

  // Helper function to ensure wallet exists for advertiser role
  const ensureAdvertiserWallet = async (userId) => {
    try {
      // Use centralized wallet creation
      await strapi.controller('api::user-wallet.user-wallet').getOrCreateWallet(userId);
      console.log(`Ensured wallet exists for user ${userId}`);
    } catch (error) {
      console.error('Error creating wallet for advertiser:', error);
    }
  };

  // Add lifecycle hooks
  plugin.contentTypes.user.lifecycles = {
    async afterCreate(event) {
      const { result } = event;

      try {
        strapi.log.info(`[LIFECYCLE afterCreate] User ${result.id} created with:`, {
          Advertiser: result.Advertiser,
          Publisher: result.Publisher,
          AdvertiserType: typeof result.Advertiser,
          PublisherType: typeof result.Publisher
        });

        // Create unified wallet for ALL users (both advertisers and publishers)
        await ensureAdvertiserWallet(result.id);
        console.log(`[USER REGISTRATION] Created wallet for new user ${result.id}`);

        // Ensure Publisher field is set if not explicitly provided during registration
        const shouldSetPublisher = result.Publisher === undefined && !result.Advertiser;

        strapi.log.info(`[LIFECYCLE] Should set Publisher?`, {
          shouldSetPublisher,
          PublisherIsUndefined: result.Publisher === undefined,
          AdvertiserIsFalsy: !result.Advertiser
        });

        if (shouldSetPublisher) {
          strapi.log.info(`[LIFECYCLE] Setting Publisher to true for user ${result.id}`);
          await strapi.entityService.update(
            'plugin::users-permissions.user',
            result.id,
            { data: { Publisher: true } }
          );
        }

        // ========== AUTO-LINK ORPHANED WEBSITES ==========
        // Find websites with matching email but no currentPublisherId linked
        const userEmail = result.email;
        const userId = result.id;

        if (userEmail) {
          console.log(`[Auto-Claim] Checking for orphaned websites for ${userEmail} (ID: ${userId})`);

          // Use raw database query to find orphaned websites
          // Strapi's $null operator doesn't work correctly for relations stored in link tables
          const knex = strapi.db.connection;

          const orphanedSites = await knex('publisher_websites AS pw')
            .leftJoin('publisher_websites_current_publisher_id_lnk AS lnk', 'pw.id', 'lnk.publisher_website_id')
            .whereNull('lnk.user_id')
            .where('pw.publisher_email', userEmail)
            .select('pw.id', 'pw.url', 'pw.publisher_email');

          console.log(`[Auto-Claim] Found ${orphanedSites.length} orphaned sites for ${userEmail}:`, orphanedSites.map(s => s.url));

          if (orphanedSites.length > 0) {
            strapi.log.info(`[Auto-Claim] Found ${orphanedSites.length} orphaned websites for new user ${userEmail} (ID: ${userId}). Linking now...`);

            // Update each website individually using entityService
            let linkedCount = 0;
            for (const site of orphanedSites) {
              try {
                console.log(`[Auto-Claim] Linking website ${site.id} (${site.url}) to user ${userId}`);
                await strapi.entityService.update('api::publisher-website.publisher-website', site.id, {
                  data: {
                    currentPublisherId: userId,
                    originalPublisherId: userId
                  }
                });
                linkedCount++;
                console.log(`[Auto-Claim] Successfully linked website ${site.id}`);
              } catch (updateErr) {
                console.error(`[Auto-Claim ERROR] Failed to link website ${site.id} (${site.url}):`, updateErr.message);
              }
            }

            strapi.log.info(`[Auto-Claim] Successfully linked ${linkedCount}/${orphanedSites.length} websites to user ID ${userId}.`);
            console.log(`[Auto-Claim] Finished: linked ${linkedCount}/${orphanedSites.length} websites`);
          } else {
            console.log(`[Auto-Claim] No orphaned sites found for ${userEmail}`);
          }
        }
        // ========== END AUTO-LINK ORPHANED WEBSITES ==========

        // ========== AUTOSEND CONTACT SYNC ==========
        try {
          const autoSendService = strapi.service('api::global.autosend-service');
          if (autoSendService && typeof autoSendService.createContact === 'function') {
            strapi.log.info(`[AutoSend] Syncing new user ${result.email} to AutoSend...`);

            // Prepare custom fields based on user role/type
            const customFields = {
              role: 'user', // Default role
              is_advertiser: result.Advertiser ? 'true' : 'false',
              is_publisher: result.Publisher ? 'true' : 'false',
              registration_date: new Date().toISOString().split('T')[0]
            };

            // Get the list ID from environment to add new users to mailing list
            const listId = process.env.AUTOSEND_LIST_ID;
            const listIds = listId ? [listId] : [];

            await autoSendService.createContact({
              email: result.email,
              firstName: result.firstName || '',
              lastName: result.lastName || '',
              userId: result.id,
              customFields,
              listIds
            });
          }
        } catch (autoSendError) {
          // Double safety catch, though service handles its own errors
          console.error('[AutoSend Sync Error]', autoSendError);
        }
        // ========== END AUTOSEND CONTACT SYNC ==========

      } catch (error) {
        console.error('Error in user lifecycle hook:', error);
      }
    },

    // ──────────────────────────────────────────────────────────────────────
    // afterUpdate: keep marketplaces.publisher_email in sync as a
    // denormalized cache of the user's current email. The publisher FK
    // is the source of truth for OWNERSHIP; this column is just a fast
    // display copy that some legacy code paths still read. Without this
    // sync, the cache drifts when a user changes their email (via admin
    // panel, /api/users/me, or Clerk's user.updated webhook).
    // ──────────────────────────────────────────────────────────────────────
    async afterUpdate(event) {
      const { result, params } = event;
      // Only act if email was in the update payload — most user updates
      // (country, phone, etc.) don't need this cascade.
      if (!params?.data?.email || !result?.id) return;

      try {
        const updatedCount = await strapi.db.connection('marketplaces')
          .whereIn(
            'id',
            strapi.db.connection('marketplaces_publisher_lnk')
              .select('marketplace_id')
              .where({ user_id: result.id })
          )
          .update({ publisher_email: result.email });

        if (updatedCount > 0) {
          strapi.log.info(
            `[LIFECYCLE afterUpdate] Cascaded email change to ${updatedCount} marketplace(s) for user ${result.id} (${result.email})`
          );
        }
      } catch (err) {
        strapi.log.error(
          `[LIFECYCLE afterUpdate] Failed to cascade email to marketplaces: ${err.message}`
        );
      }
    },

    // ──────────────────────────────────────────────────────────────────────
    // beforeDelete / beforeDeleteMany: refuse to delete a user who still
    // owns marketplaces. Surfaces a friendly error in the admin panel and
    // via the API. The DB also enforces this via ON DELETE RESTRICT on
    // marketplaces_publisher_lnk.user_id (set in src/index.js bootstrap) —
    // these hooks just provide a cleaner message before the DB rejects.
    // ──────────────────────────────────────────────────────────────────────
    async beforeDelete(event) {
      await blockUserDeleteIfOwnsMarketplaces(event.params.where);
    },
    async beforeDeleteMany(event) {
      await blockUserDeleteIfOwnsMarketplaces(event.params.where);
    },
  };

  // Fields a regular authenticated user is allowed to update on their own
  // profile via PUT /api/users/me. This is a fail-closed whitelist:
  // any field NOT listed here is silently stripped, regardless of whether
  // the user supplied it. This prevents mass-assignment escalations like:
  //   - marketplaceUnlocked: bypassing the deposit gate
  //   - clerkId: hijacking another user's Clerk identity
  //   - confirmed / blocked / role / Advertiser / Publisher: privilege escalation
  //   - email / password / provider: account takeover
  // Adding a new user-settable field requires explicitly extending this set.
  const ALLOWED_SELF_UPDATE = new Set([
    'username',
    'firstName',
    'lastName',
    'displayName',
    'phoneNumber',
    'businessName',
    'registrationNumber',
    'billingAddress',
    'city',
    'country',
    'billingCountry',
    'pincode',
    'vatGstNumber',
    'paypalEmail',
    'payoneerEmail',
    'notificationPreferences',
    'marketplacePreferences',
    'website',
    'identity',
    'onboardingState',
  ]);

  // Fields with enum schemas. Empty string / null is NOT a valid enum
  // value — Strapi 5's Yup validator rejects every PUT /api/users/me that
  // carries one with `YupValidationError: identity must be one of the
  // following values: SEO, Agency, Other,` (note the trailing comma —
  // that's Yup including the empty value the client sent at the end).
  //
  // Client form libraries commonly initialize select inputs to '' and
  // serialize the whole user object on save — so any user who never set
  // their identity would have every profile update crash. Drop empty /
  // null for these fields BEFORE handing off to entityService.update;
  // the semantic intent of "no value provided" is "don't change", and
  // that's what we honor.
  //
  // Add new enum-typed fields here whenever the schema gains one.
  const ENUM_FIELDS = new Set(['identity']);

  // Extend the users controller
  plugin.controllers.user.updateMe = async (ctx) => {
    try {
      if (!ctx.state.user || !ctx.state.user.id) {
        console.error('[UPDATE ME] No authenticated user found in ctx.state.user');
        return ctx.unauthorized('You must be logged in to update your profile');
      }

      const userId = ctx.state.user.id;
      const rawUpdateData = ctx.request.body.data || ctx.request.body || {};

      // Whitelist-filter the incoming payload. Drop anything outside
      // ALLOWED_SELF_UPDATE (Strapi blacklist was easy to bypass — any
      // schema field added in the future would be private-by-default-fail).
      const updateData = {};
      const droppedKeys = [];
      for (const key of Object.keys(rawUpdateData)) {
        if (!ALLOWED_SELF_UPDATE.has(key)) {
          droppedKeys.push(key);
          continue;
        }
        const value = rawUpdateData[key];
        // Drop empty / null for enum-typed fields — Yup would otherwise
        // reject the whole PUT (see ENUM_FIELDS comment above). Free-text
        // fields keep their empty-string handling so a user CAN clear
        // an optional phoneNumber / website / etc. by sending "".
        if (ENUM_FIELDS.has(key) && (value === '' || value === null || value === undefined)) {
          continue;
        }
        updateData[key] = value;
      }

      console.log('[UPDATE ME] User ID:', userId);
      console.log('[UPDATE ME] Allowed update data:', updateData);
      if (droppedKeys.length > 0) {
        console.warn(`[UPDATE ME] User ${userId} attempted to update disallowed fields, ignoring:`, droppedKeys);
      }

      // Update the user
      const updatedUser = await strapi.entityService.update(
        'plugin::users-permissions.user',
        userId,
        {
          data: updateData,
          populate: ['role', 'user_wallet']
        }
      );

      console.log('[UPDATE ME] User updated successfully:', updatedUser.id);

      // Return sanitized user data
      const sanitizedUser = sanitizeOutput(updatedUser);
      ctx.send(sanitizedUser);
    } catch (error) {
      console.error('[UPDATE ME] Error updating user:', error);
      return ctx.badRequest('Error updating user', { error: error.message });
    }
  };

  // Add role switching controller
  plugin.controllers.user.switchRole = async (ctx) => {
    try {
      if (!ctx.state.user || !ctx.state.user.id) {
        return ctx.unauthorized('You must be logged in to switch roles');
      }

      const userId = ctx.state.user.id;
      const { role } = ctx.request.body;

      // Validate role
      if (role !== 'advertiser' && role !== 'publisher') {
        return ctx.badRequest('Invalid role. Must be either "advertiser" or "publisher"');
      }

      // Update user role - set the selected role to true and the other to false
      const isAdvertiser = role === 'advertiser';
      const updatedUser = await strapi.entityService.update(
        'plugin::users-permissions.user',
        userId,
        {
          data: {
            Advertiser: isAdvertiser,
            Publisher: !isAdvertiser
          },
          populate: ['user_wallet']
        }
      );

      // If switching to advertiser, ensure wallet exists
      if (isAdvertiser) {
        await ensureAdvertiserWallet(userId);
      }

      // Get the updated user with wallet populated
      const userWithWallet = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        userId,
        { populate: ['user_wallet'] }
      );

      // Return sanitized user data
      ctx.body = sanitizeOutput(userWithWallet);
    } catch (error) {
      console.error('Error switching user role:', error);
      return ctx.badRequest('Error switching user role', { error: error.message });
    }
  };

  // Add update profile route (PUT /users/me)
  plugin.routes['content-api'].routes.unshift({
    method: 'PUT',
    path: '/users/me',
    handler: 'user.updateMe',
    config: {
      prefix: '',
      policies: []
    }
  });

  // Add role switching route
  plugin.routes['content-api'].routes.unshift({
    method: 'POST',
    path: '/users/switch-role',
    handler: 'user.switchRole',
    config: {
      prefix: '',
      policies: []
    }
  });

  // ===========================================================================
  // JWT token-version
  // ===========================================================================
  // Strategy: wrap verify() ONLY (it's already async upstream — adding the
  // tokenVersion check is safe). Do NOT wrap issue() — Strapi's upstream
  // auth.js controllers call jwt.issue() synchronously and place the result
  // directly in a JSON response body (login, register, forgot-password,
  // reset-password at node_modules/.../auth.js:90/104/141/173). Making issue()
  // return a Promise would ship `jwt: {}` to clients on those routes.
  //
  // Instead: expose a separate async helper `issueWithTokenVersion()` that
  // our own callers (clerk sync, admin login) use. Upstream-minted JWTs lack
  // the tokenVersion claim — which the verify() check treats as 0. New users
  // default to tokenVersion=0 → upstream JWTs validate fine until the first
  // logout/revoke/role-change for that user, at which point tokenVersion
  // becomes >= 1 and the upstream-minted JWT is rejected. So upstream callers
  // are auto-revoked-aware without any modification.
  const upstreamJwtFactory = plugin.services.jwt;
  plugin.services.jwt = (deps) => {
    const base = upstreamJwtFactory(deps);
    const { strapi } = deps;
    return {
      ...base,
      // issue() is intentionally unchanged from upstream (sync).
      /**
       * Async helper for our own callers (clerk.js, admin/admin.js).
       * Looks up the user's current tokenVersion and embeds it in the claim
       * so this specific JWT survives the verify() check until the next
       * tokenVersion bump.
       */
      async issueWithTokenVersion(payload, jwtOptions) {
        const enriched = { ...(payload || {}) };
        if (enriched.id != null && enriched.tokenVersion === undefined) {
          enriched.tokenVersion = await lookupTokenVersion(strapi, enriched.id);
        }
        return base.issue(enriched, jwtOptions);
      },
      /**
       * verify(token) — calls upstream (decodes + verifies signature), then
       * rejects if the claim's tokenVersion is less than the user's current
       * tokenVersion in the DB. Missing claim tokenVersion is treated as 0
       * (back-compat for JWTs issued before this code shipped).
       */
      async verify(token) {
        const payload = await base.verify(token);
        if (!payload || payload.id == null) return payload;
        const claimTv = payload.tokenVersion ?? 0;
        const userTv = await lookupTokenVersion(strapi, payload.id);
        if (claimTv < userTv) {
          // Mirror the upstream error shape so the strategy treats this
          // as a normal invalid-token failure (401, not 500).
          throw new Error('Invalid token.');
        }
        return payload;
      },
    };
  };

  // ===========================================================================
  // Lifecycle bump trigger
  // ===========================================================================
  // Bump tokenVersion when an admin (or any code path) updates security-
  // sensitive fields on a user: role, blocked, confirmed. The role-switch
  // controller (Advertiser/Publisher flag flip) is intentionally NOT a
  // trigger — that's a normal product flow and shouldn't kick the user out.
  const TOKEN_REVOKING_FIELDS = new Set(['role', 'blocked', 'confirmed']);

  const existingBeforeUpdate = plugin.contentTypes.user.lifecycles.beforeUpdate;
  plugin.contentTypes.user.lifecycles.beforeUpdate = async (event) => {
    if (existingBeforeUpdate) await existingBeforeUpdate(event);
    const data = (event.params && event.params.data) || {};
    const whereId = event.params && event.params.where && event.params.where.id;
    if (!whereId) return;
    const touchesSecurity = Object.keys(data).some((k) => TOKEN_REVOKING_FIELDS.has(k));
    if (!touchesSecurity) return;
    // Inject the bump into the same UPDATE so it commits atomically with
    // the role/blocked change. We add 1 to the CURRENT value here; for
    // concurrent writers a transient stale-read is fine — the only effect
    // is one extra invalidation generation, never a missed revocation.
    const currentTv = await lookupTokenVersion(strapi, whereId);
    data.tokenVersion = currentTv + 1;
    strapi.log.info(`[jwt.tokenVersion] beforeUpdate bumping user=${whereId} reason=field-change touched=${Object.keys(data).filter(k => TOKEN_REVOKING_FIELDS.has(k)).join(',')}`);
  };

  // ===========================================================================
  // Logout + manual revoke endpoints live in src/api/auth/controllers/session.js
  // and src/api/auth/routes/session.js (standard Strapi API loader; extending
  // the users-permissions plugin's controllers from here proved unreliable
  // for net-new methods in Strapi 5).
  //
  // Password-change wrap: defensive — Clerk owns auth in this project so
  // Strapi's built-in changePassword endpoint is rarely hit, but if anyone
  // re-enables Strapi's local password flow the revocation comes along.
  // ===========================================================================
  if (plugin.controllers.auth && typeof plugin.controllers.auth.changePassword === 'function') {
    const upstreamChangePassword = plugin.controllers.auth.changePassword;
    plugin.controllers.auth.changePassword = async (ctx) => {
      const result = await upstreamChangePassword(ctx);
      if (ctx.state.user && ctx.state.user.id) {
        await bumpTokenVersion(strapi, ctx.state.user.id, 'password-change');
      }
      return result;
    };
  }

  return plugin;
}; 