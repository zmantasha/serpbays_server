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