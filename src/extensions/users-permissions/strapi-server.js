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

  // Add lifecycle hooks
  plugin.contentTypes.user.lifecycles = {
    async afterCreate(event) {
      const { result } = event;
      
      try {
        // Only create wallet for advertisers
        if (result.Advertiser) {
          // Check if wallet already exists
          const existingWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
            where: { users_permissions_user: result.id }
          });

          if (!existingWallet) {
            // Create a new wallet with numeric balance values
            await strapi.entityService.create('api::user-wallet.user-wallet', {
              data: {
                users_permissions_user: result.id,
                balance: 0,
                escrowBalance: 0,
                currency: "USD",
                status: "active",
                type: "advertiser",
                publishedAt: new Date()
              }
            });
            console.log(`Created wallet for new advertiser user ${result.id}`);
          }
        }
      } catch (error) {
        console.error('Error creating wallet for new user:', error);
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

  // Add the custom route
  plugin.routes['content-api'].routes.push({
    method: 'PUT',
    path: '/users/me',
    handler: 'user.updateMe',
    config: {
      prefix: '',
      policies: []
    }
  });

  return plugin;
}; 