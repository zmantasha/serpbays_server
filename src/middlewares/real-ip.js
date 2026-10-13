'use strict';

/**
 * Real client IP (2026-10-13).
 *
 * Strapi only sees nginx (127.0.0.1) as the TCP peer, so every audit row and
 * every IP-based rate limit used "127.0.0.1" — all visitors shared one bucket.
 * nginx now resolves the visitor address from Cloudflare (realip module,
 * /etc/nginx/conf.d/cloudflare-realip.conf) and passes it as X-Real-IP. We
 * trust that header ONLY when the request came from the local nginx, so a
 * client can't fake its address by sending the header itself.
 */
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

module.exports = () => async (ctx, next) => {
  const peer = ctx.req && ctx.req.socket && ctx.req.socket.remoteAddress;
  const real = ctx.get('x-real-ip');
  if (real && LOCAL.has(peer) && IP_RE.test(real)) ctx.request.ip = real;
  await next();
};
