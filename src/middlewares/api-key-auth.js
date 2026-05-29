'use strict';

/**
 * api-key-auth middleware
 *
 * Authenticates external API clients (selected partners) via a per-client
 * API key, for the public-facing /api/external/v1/* endpoints.
 *
 * Responsibilities:
 *   1. Read the key from `Authorization: Bearer <key>` or `X-API-Key`.
 *   2. Look up the user holding that key, requiring apiAccess === true.
 *   3. Reject 401 on missing key / unknown key / revoked access / blocked user.
 *   4. Populate ctx.state.user so the marketplace controller treats the
 *      caller as a normal advertiser (active listings + advertiser prices,
 *      publisher data stripped by sanitizePublisherData).
 *   5. Force marketplaceUnlocked IN MEMORY so the deposit-gate in
 *      marketplace.find() does not cap the client to a 10-row preview.
 *      This is not persisted — it only affects this request.
 *
 * Used with `auth: false` on the route so Strapi skips its built-in
 * users-permissions permission check (the API user has no per-action grants).
 *
 * NOTE: revoke a client by clearing apiKey or setting apiAccess = false on
 * their user record. No code change or redeploy required.
 */

module.exports = () => {
  return async (ctx, next) => {
    const header = ctx.request.headers.authorization || '';
    const bearer = /^Bearer (.+)$/.exec(header);
    const key = bearer ? bearer[1] : ctx.request.headers['x-api-key'];

    if (!key) {
      return ctx.unauthorized('Missing API key');
    }

    const users = await strapi.entityService.findMany('plugin::users-permissions.user', {
      filters: { apiKey: key, apiAccess: true },
      populate: ['role'],
      limit: 1,
    });

    const user = Array.isArray(users) ? users[0] : users;

    if (!user) {
      return ctx.unauthorized('Invalid API key or API access not enabled');
    }
    if (user.blocked) {
      return ctx.unauthorized('User account is blocked');
    }

    // Treat the client as an advertiser and bypass the deposit gate for this
    // request only (see marketplace.find: manuallyUnlocked check). Never saved.
    user.Advertiser = true;
    user.Publisher = false;
    user.marketplaceUnlocked = true;

    ctx.state.user = user;
    ctx.state.auth = { credentials: user, strategy: { name: 'api-key-auth' } };

    await next();
  };
};
