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
      const existingWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
        where: { users_permissions_user: userId }
      });

      if (!existingWallet) {
        await strapi.entityService.create('api::user-wallet.user-wallet', {
          data: {
            users_permissions_user: userId,
            balance: 0,
            escrowBalance: 0,
            currency: "USD",
            status: "active",
            type: "advertiser",
            publishedAt: new Date()
          }
        });
        console.log(`Created wallet for advertiser user ${userId}`);
      }
    } catch (error) {
      console.error('Error creating wallet for advertiser:', error);
    }
  };

  // Add lifecycle hooks
  plugin.contentTypes.user.lifecycles = {
    async afterCreate(event) {
      const { result } = event;
      
      try {
        // Only create wallet for advertisers
        if (result.Advertiser) {
          await ensureAdvertiserWallet(result.id);
        }
        
        // Ensure Publisher field is set if not explicitly provided during registration
        if (result.Publisher === undefined && !result.Advertiser) {
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
        return ctx.unauthorized('You must be logged in to update your profile');
      }

      const userId = ctx.state.user.id;
      const updateData = ctx.request.body.data || ctx.request.body;

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
        { data: updateData }
      );

      // Return sanitized user data
      ctx.body = sanitizeOutput(updatedUser);
    } catch (error) {
      console.error('Error updating user:', error);
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

  // Add the custom routes
  plugin.routes['content-api'].routes.push({
    method: 'PUT',
    path: '/users/me',
    handler: 'user.updateMe',
    config: {
      prefix: '',
      policies: []
    }
  });

  plugin.routes['content-api'].routes.push({
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