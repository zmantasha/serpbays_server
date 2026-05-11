'use strict';

/**
 * admin-jwt-auth middleware
 *
 * Drop-in replacement for the default users-permissions permission check on
 * admin-panel routes. The default check requires a DB-stored permission grant
 * per-action for the Authenticated role; for admin-namespace endpoints we want
 * the is-admin policy (role.type in admin/super_admin/moderator) to be the
 * sole authorization gate.
 *
 * Responsibilities:
 *   1. Read Bearer JWT.
 *   2. Validate via users-permissions JWT service.
 *   3. Load the user with populated role.
 *   4. Populate ctx.state.user so the global::is-admin policy (which runs next)
 *      can authorize based on role.type.
 *   5. Reject with 401 on missing / invalid / expired JWT so a stale session
 *      doesn't surface as a "Forbidden" message.
 *
 * Used in combination with `auth: false` on the route so Strapi skips its
 * built-in permission check.
 */

module.exports = () => {
  return async (ctx, next) => {
    const header = ctx.request.headers.authorization || '';
    const match = /^Bearer (.+)$/.exec(header);

    if (!match) {
      return ctx.unauthorized('Missing or invalid authorization header');
    }

    const token = match[1];

    try {
      const jwtService = strapi.plugin('users-permissions').service('jwt');
      const payload = await jwtService.verify(token);
      if (!payload?.id) {
        return ctx.unauthorized('Invalid token payload');
      }

      const user = await strapi.entityService.findOne('plugin::users-permissions.user', payload.id, {
        populate: ['role']
      });

      if (!user) {
        return ctx.unauthorized('User no longer exists');
      }
      if (user.blocked) {
        return ctx.unauthorized('User account is blocked');
      }

      ctx.state.user = user;
      ctx.state.auth = { credentials: user, strategy: { name: 'admin-jwt-auth' } };
    } catch (err) {
      return ctx.unauthorized('Invalid or expired token');
    }

    await next();
  };
};
