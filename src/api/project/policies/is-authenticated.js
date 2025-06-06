'use strict';

/**
 * `is-authenticated` policy for project API
 */

module.exports = (policyContext, config, { strapi }) => {
  const { user } = policyContext.state;

  if (!user) {
    return false;
  }

  // Additional project-specific checks can be added here
  // For example, checking if the user is an advertiser

  return true;
}; 