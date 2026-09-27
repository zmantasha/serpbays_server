'use strict';

/**
 * Admin session refresh.
 *
 *   POST /admin/session/refresh   (Bearer: a still-valid admin JWT)
 *   → { jwt, expiresAt, userId }
 *
 * The admin panel's NextAuth cookie is rolling (7 d, extended on use) but
 * the Strapi JWT inside it was fixed at 7 d from login, so long-lived
 * sessions silently died: the panel stayed "logged in" while every API
 * call 401'd. The panel's jwt callback now calls this before the JWT
 * expires. Strictly requires a currently valid token (the policy rejects
 * expired ones), so an expired session can only be fixed by logging in.
 */
module.exports = {
  async refresh(ctx) {
    const user = ctx.state.user;
    if (!user || !user.id) return ctx.unauthorized('No user');
    if (user.blocked) return ctx.unauthorized('User account is blocked');
    const roleType = user.role && user.role.type;
    if (!['super_admin', 'admin'].includes(roleType)) return ctx.forbidden('Not an admin');

    const jwtService = strapi.plugin('users-permissions').service('jwt');
    const jwt = jwtService.issue({ id: user.id });
    let expiresAt = null;
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
      if (payload && payload.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
    } catch (e) { /* ignore */ }
    strapi.log.info(`[ADMIN SESSION] refreshed JWT for user ${user.id} (${roleType}) exp=${expiresAt}`);
    ctx.send({ jwt, expiresAt, userId: user.id });
  },
};
