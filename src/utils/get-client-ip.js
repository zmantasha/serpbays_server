'use strict';

/**
 * Return the real client IP, tolerant of a reverse-proxy / CDN chain.
 *
 * Priority order (Cloudflare-first, since serpbays is fronted by CF):
 *   1. CF-Connecting-IP  — Cloudflare's canonical single-value client IP
 *   2. True-Client-IP    — Cloudflare Enterprise alt header
 *   3. X-Real-IP         — some reverse proxies set this
 *   4. X-Forwarded-For   — leftmost value = original client
 *   5. ctx.request.ip    — koa's own resolution (works only when
 *                          config/server.js sets `proxy: true`)
 *
 * Loopback / link-local values are filtered out — those only appear when
 * the reverse-proxy chain is misconfigured, and they must NEVER be fed
 * into anti-fraud comparisons (they would make every visitor look
 * identical). If every candidate collapses to loopback, we return null
 * and the caller is expected to skip the IP-based check gracefully.
 *
 * For rate-limiting-style callers that need SOMETHING, use
 * `getClientIpOrFallback(ctx)`.
 */
function isLoopback(ip) {
  if (!ip) return true;
  const s = String(ip).trim().toLowerCase();
  return (
    s === '127.0.0.1' ||
    s === '::1' ||
    s === '::ffff:127.0.0.1' ||
    s.startsWith('10.') ||          // RFC1918 — internal orchestration net
    s.startsWith('172.16.') ||
    s.startsWith('172.17.') ||
    s.startsWith('172.18.') ||
    s.startsWith('172.19.') ||
    s.startsWith('172.2') ||
    s.startsWith('172.31.') ||
    s.startsWith('192.168.') ||
    s.startsWith('169.254.')        // link-local
  );
}

function candidates(ctx) {
  const h = ctx?.request?.headers || {};
  const xffFirst =
    typeof h['x-forwarded-for'] === 'string'
      ? h['x-forwarded-for'].split(',')[0].trim()
      : null;
  return [
    h['cf-connecting-ip'],
    h['true-client-ip'],
    h['x-real-ip'],
    xffFirst,
    ctx?.request?.ip,
  ];
}

/**
 * For anti-fraud / attribution comparisons. Returns null if we can't
 * resolve a plausible public client IP — callers should treat null as
 * "IP-based guard is not applicable for this request".
 */
function getClientIp(ctx) {
  for (const raw of candidates(ctx)) {
    if (!raw) continue;
    const ip = String(raw).trim();
    if (isLoopback(ip)) continue;
    return ip;
  }
  return null;
}

/**
 * For rate limiting and per-IP rate keys. Never returns null — falls
 * back to the first non-empty candidate (including loopback) so the
 * limiter always has a key.
 */
function getClientIpOrFallback(ctx) {
  const real = getClientIp(ctx);
  if (real) return real;
  for (const raw of candidates(ctx)) {
    if (raw) return String(raw).trim();
  }
  return 'unknown';
}

module.exports = { getClientIp, getClientIpOrFallback, isLoopback };
