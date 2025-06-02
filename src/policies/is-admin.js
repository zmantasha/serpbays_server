'use strict';

/**
 * `is-admin` policy
 */

module.exports = async (policyContext, config, { strapi }) => {
  try {
    // Get user from the context
    const user = policyContext.state.user;

    if (!user) {
      return false;
    }

    // Get the user's role
    const userWithRole = await strapi.query('plugin::users-permissions.user').findOne({
      where: { id: user.id },
      populate: ['role'],
    });

    if (!userWithRole || !userWithRole.role) {
      return false;
    }

    // Check if the user's role is admin
    return userWithRole.role.type === 'admin';
  } catch (error) {
    console.error('Error in is-admin policy:', error);
    return false;
  }
}; 