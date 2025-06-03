'use strict';

/**
 * `is-authenticated` policy
 */
module.exports = async (policyContext, config, { strapi }) => {
  try {
    // Get the JWT token from the header
    const { authorization } = policyContext.request.headers;
    if (!authorization) {
      return false;
    }

    // Extract the token
    const token = authorization.replace('Bearer ', '');
    if (!token) {
      return false;
    }

    // Verify and decode the token
    const decoded = await strapi.plugins['users-permissions'].services.jwt.verify(token);
    
    // Get the user
    const user = await strapi.plugins['users-permissions'].services.user.fetch(decoded.id, {
      populate: ['role'],
    });

    if (!user) {
      return false;
    }

    // Check if user is admin
    if (!user.role || user.role.type !== 'admin') {
      return false;
    }

    // Set the user in the state
    policyContext.state.user = user;
    return true;
  } catch (error) {
    strapi.log.error('Authentication error:', error);
    return false;
  }
}; 