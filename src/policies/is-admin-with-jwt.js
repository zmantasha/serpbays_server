'use strict';

/**
 * `is-admin-with-jwt` policy
 *
 * Single-step authentication + authorization for admin-panel routes that
 * cannot rely on users-permissions auth (because no per-action permission
 * row has been seeded for the role). Validates the Bearer JWT, loads the
 * user, populates `ctx.state.user`, and verifies that role.type is in the
 * admin allowlist — all in one policy run.
 *
 * Used with `auth: false` on the route so Strapi skips its built-in
 * users-permissions permission check.
 */

const ALLOWED_ROLE_TYPES = ['super_admin', 'admin'];

module.exports = async (policyContext, config, { strapi }) => {
  const { request, state } = policyContext;
  const header = request.headers.authorization || '';
  const match = /^Bearer (.+)$/.exec(header);

  if (!match) {
    strapi.log.warn('[ACCESS DENIED] Missing or malformed authorization header');
    return false;
  }

  try {
    const jwtService = strapi.plugin('users-permissions').service('jwt');
    const payload = await jwtService.verify(match[1]);
    if (!payload?.id) {
      strapi.log.warn('[ACCESS DENIED] Invalid JWT payload');
      return false;
    }

    const user = await strapi.entityService.findOne('plugin::users-permissions.user', payload.id, {
      populate: ['role'],
    });

    if (!user) {
      strapi.log.warn('[ACCESS DENIED] User no longer exists');
      return false;
    }
    if (user.blocked) {
      strapi.log.warn(`[ACCESS DENIED] User ${user.id} is blocked`);
      return false;
    }

    const roleType = user.role?.type;
    if (!ALLOWED_ROLE_TYPES.includes(roleType)) {
      strapi.log.warn(`[ACCESS DENIED] User ${user.id} (${user.email}) role '${roleType}' is not an admin role`);
      return false;
    }

    state.user = user;
    state.auth = { credentials: user, strategy: { name: 'is-admin-with-jwt' } };
    strapi.log.warn(`[ADMIN ACCESS] User ${user.id} (${user.email}) with role '${roleType}' accessed admin endpoint`);
    return true;
  } catch (err) {
    strapi.log.warn(`[ACCESS DENIED] JWT verification failed: ${err.message}`);
    return false;
  }
};
