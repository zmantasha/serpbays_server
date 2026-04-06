'use strict';

module.exports = (plugin) => {
  // Get the original controller
  const sanitizeOutput = (user) => {
    const {
      password, resetPasswordToken, confirmationToken,
      ...sanitizedUser
    } = user;
    return sanitizedUser;
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

            // Step 1: Create contact WITHOUT list assignment
            // This ensures firstName/lastName are fully saved before any automation triggers
            await autoSendService.createContact({
              email: result.email,
              firstName: result.firstName || '',
              lastName: result.lastName || '',
              userId: result.id,
              customFields,
            });

            // Step 2: Add to signup list separately after a brief delay
            // The automation triggers on list addition — by now firstName is committed
            const listId = process.env.AUTOSEND_LIST_ID;
            if (listId) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              await autoSendService.addToList({ email: result.email, listId });
              strapi.log.info(`[AutoSend] Added ${result.email} to signup list ${listId}`);
            }
          }
        } catch (autoSendError) {
          // Double safety catch, though service handles its own errors
          console.error('[AutoSend Sync Error]', autoSendError);
        }
        // ========== END AUTOSEND CONTACT SYNC ==========

      } catch (error) {
        console.error('Error in user lifecycle hook:', error);
      }
    }
  };

  // Extend the users controller
  plugin.controllers.user.updateMe = async (ctx) => {
    try {
      if (!ctx.state.user || !ctx.state.user.id) {
        console.error('[UPDATE ME] No authenticated user found in ctx.state.user');
        return ctx.unauthorized('You must be logged in to update your profile');
      }

      const userId = ctx.state.user.id;
      const updateData = ctx.request.body.data || ctx.request.body;

      console.log('[UPDATE ME] User ID:', userId);
      console.log('[UPDATE ME] Update data:', updateData);

      // Ensure we can't update critical fields
      delete updateData.email;
      delete updateData.password;
      delete updateData.provider;
      delete updateData.confirmed;
      delete updateData.blocked;
      delete updateData.role;
      // Role flags must only be changed via the dedicated /users/switch-role endpoint.
      // Stripping them here prevents PUT /api/users/me from flipping a user's role
      // (which silently broke marketplace visibility for users whose role drifted).
      delete updateData.Advertiser;
      delete updateData.Publisher;

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

  return plugin;
}; 