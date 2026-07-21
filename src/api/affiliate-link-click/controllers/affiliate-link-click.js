'use strict';

/**
 * Public click-tracking endpoint.
 *
 * POST /api/affiliate-tracking/click
 *   body: { code, landingPath?, utmSource?, utmMedium?, utmCampaign? }
 *
 * Auth: false (visitors haven't signed up yet). Rate-limited by IP + by code
 * (see src/utils/affiliate-click-limiter.js). Response is intentionally
 * uniform whether the code resolves or not — no oracle for code existence.
 *
 * All caller-supplied strings are truncated and validated at the boundary.
 * IP is hashed with a server-side salt; raw IP is never stored.
 */

const { createCoreController } = require('@strapi/strapi').factories;
const crypto = require('crypto');
const { normaliseCode } = require('../../../utils/referral-code');
const limiter = require('../../../utils/affiliate-click-limiter');

const IP_HASH_SALT = () =>
  process.env.AFFILIATE_IP_HASH_SALT || process.env.APP_KEYS?.split(',')[0] || 'change-me-in-env';

const hashIp = (ip) => {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip) + '|' + IP_HASH_SALT()).digest('hex');
};

const clampString = (v, max) => {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

// Strip query-string from landingPath so we don't accidentally store auth
// tokens or PII that the client might forward from window.location.
const cleanPath = (v) => {
  const p = clampString(v, 512);
  if (!p) return null;
  const q = p.indexOf('?');
  return q >= 0 ? p.slice(0, q) : p;
};

// Country from typical proxy headers set by Cloudflare / Vercel / etc.
const readCountry = (ctx) => {
  const h = ctx.request?.headers || {};
  const c = h['cf-ipcountry'] || h['x-vercel-ip-country'] || h['x-appengine-country'];
  if (typeof c !== 'string') return null;
  const iso = c.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(iso) ? iso : null;
};

module.exports = createCoreController('api::affiliate-link-click.affiliate-link-click', ({ strapi }) => ({
  /**
   * Public click-record endpoint.
   * Always returns 204 (No Content) on success — no body, no leak of
   * whether the code was valid.
   */
  async recordClick(ctx) {
    const body = ctx.request?.body || {};
    const rawCode = body.code || body.referralCode || body.ref;
    const code = normaliseCode(rawCode);

    const ipAddress =
      ctx.request?.ip ||
      (ctx.request?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
      null;

    // Rate-limit BEFORE any DB work — cheap for an attacker to burn a socket,
    // expensive to have every burst hit the DB. Check both per-IP and per-code
    // (use the normalised code so codeKey is stable even for invalid input).
    const gate = await limiter.check(ipAddress, code || 'invalid');
    if (!gate.allowed) {
      ctx.set('Retry-After', String(gate.retryAfterSeconds || 60));
      // Still 204 — don't tell the caller they're being throttled (harder to
      // tune an attack). The Retry-After header is informative for honest
      // clients but doesn't confirm which layer blocked them.
      ctx.status = 204;
      return;
    }

    // Bad or missing code — still 204, do NOT write a DB row. The rate-limit
    // increment above already provides fraud accounting for junk requests.
    if (!code) {
      ctx.status = 204;
      return;
    }

    try {
      // Resolve the affiliate. We store the click either way (even if the
      // affiliate is disabled) for analytics — but a resolved-null `affiliate`
      // relation prevents the attribution service from ever picking this up.
      const affiliate = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
        where: { referralCode: code, status: 'active' },
        select: ['id'],
      });

      await strapi.entityService.create('api::affiliate-link-click.affiliate-link-click', {
        data: {
          referralCode: code,
          affiliate: affiliate ? affiliate.id : null,
          clickedAt: new Date(),
          ipHash: hashIp(ipAddress),
          country: readCountry(ctx),
          userAgent: clampString(ctx.request?.headers?.['user-agent'], 512),
          landingPath: cleanPath(body.landingPath),
          utmSource:   clampString(body.utmSource,   128),
          utmMedium:   clampString(body.utmMedium,   128),
          utmCampaign: clampString(body.utmCampaign, 128),
          attributedToSignup: false,
        },
      });
    } catch (err) {
      // Best-effort — don't let a DB hiccup break the referral flow. Silent
      // to the caller; logged for ops.
      strapi.log.warn(`[affiliate-tracking/click] insert failed: ${err.message}`);
    }

    ctx.status = 204;
    return;
  },
}));
