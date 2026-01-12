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