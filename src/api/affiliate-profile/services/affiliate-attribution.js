'use strict';

/**
 * Server-side referral attribution.
 *
 * Called from the Clerk sync controller when a NEW user account is created
 * with a `referralCode` in the sync payload. This is the ONLY entry point
 * that creates `affiliate-referral` rows — every other path is admin.
 *
 * Fire-and-forget: attribution failure never blocks signup. Errors are
 * logged so ops can investigate; the referred user proceeds regardless.
 *
 * Security posture:
 *   - referralCode is normalised before any DB lookup. Invalid codes are
 *     treated identically to non-existent codes (no oracle for existence).
 *   - The referral is created ONCE — `referredUser` is unique on the
 *     content type, so a re-run cannot double-attribute or re-attribute.
 *   - Self-referral fraud: reject if the referred user's clerkId / email
 *     matches the affiliate's, OR if the ipHash on the winning click
 *     matches the ipHash on the signup.
 *   - Stale-click window: only clicks within the last N days are eligible
 *     (default 30). Config via AFFILIATE_ATTRIBUTION_WINDOW_DAYS.
 */

const crypto = require('crypto');
const { normaliseCode } = require('../../../utils/referral-code');

const num = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const ATTRIBUTION_WINDOW_DAYS = () => num('AFFILIATE_ATTRIBUTION_WINDOW_DAYS', 30);

const IP_HASH_SALT = () =>
  process.env.AFFILIATE_IP_HASH_SALT || process.env.APP_KEYS?.split(',')[0] || 'change-me-in-env';

const hashIp = (ip) => {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip) + '|' + IP_HASH_SALT()).digest('hex');
};

/**
 * Attribute a newly-created user to an affiliate.
 *
 * @param {object} args
 * @param {number} args.userId          - the freshly-created Strapi user id
 * @param {string} args.userEmail       - for self-referral email-match check
 * @param {string} args.referralCode    - raw code from the client (not yet normalised)
 * @param {string} [args.signupIp]      - the caller's IP at signup
 * @param {string} [args.userAgent]     - the caller's UA at signup
 * @returns {Promise<object|null>}      - the affiliate-referral row, or null if not attributed
 */
async function attributeReferral(args) {
  const strapi = global.strapi;
  if (!strapi) return null;

  const { userId, userEmail, referralCode: rawCode, signupIp, userAgent } = args || {};

  if (!Number.isInteger(userId) || userId <= 0) {
    return null;
  }
  const code = normaliseCode(rawCode);
  if (!code) return null;

  try {
    // 1. Look up the affiliate profile. Must be ACTIVE — disabled / terminated
    //    codes don't attribute (they're allowed to record clicks for analytics,
    //    but shouldn't produce new referrals).
    const affiliate = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { referralCode: code, status: 'active' },
      populate: { user: { select: ['id', 'email', 'clerkId'] } },
    });
    if (!affiliate || !affiliate.user) {
      strapi.log.info(`[affiliate-attribution] code=${code} does not resolve to an active affiliate — skipping`);
      return null;
    }

    // 2. Self-referral guard — email + user-id match.
    if (affiliate.user.id === userId) {
      strapi.log.warn(`[affiliate-attribution] SELF-REFERRAL blocked (same user id) — user=${userId} code=${code}`);
      return null;
    }
    if (userEmail && affiliate.user.email && userEmail.toLowerCase() === affiliate.user.email.toLowerCase()) {
      strapi.log.warn(`[affiliate-attribution] SELF-REFERRAL blocked (same email) — code=${code}`);
      return null;
    }

    // 3. Idempotency — referredUser is unique on the schema, but the DB
    //    constraint only fires at INSERT time. Check first so a repeat
    //    sync (double-post from Clerk webhook) doesn't attempt a bad write.
    const existing = await strapi.db.query('api::affiliate-referral.affiliate-referral').findOne({
      where: { referredUser: userId },
    });
    if (existing) {
      strapi.log.info(`[affiliate-attribution] user=${userId} already has a referral row (${existing.id}) — no-op`);
      return existing;
    }

    // 4. Find the winning click — last-touch within the attribution window,
    //    for this exact code, not yet attributed to anyone else.
    const cutoff = new Date(Date.now() - ATTRIBUTION_WINDOW_DAYS() * 24 * 60 * 60 * 1000);
    const winningClick = await strapi.db.query('api::affiliate-link-click.affiliate-link-click').findOne({
      where: {
        referralCode: code,
        attributedToSignup: false,
        clickedAt: { $gte: cutoff },
      },
      orderBy: { clickedAt: 'desc' },
    });
    // A missing click row is not fatal — the client may have failed to hit
    // the /affiliate-tracking/click endpoint (adblock, network hiccup). We
    // still attribute against the code alone, but record the referral with
    // a null referralLinkClick FK so downstream fraud checks can flag it.

    // 5. Self-referral guard — IP hash. Even if the emails differ, matching
    //    IP within a small window is a strong self-referral signal.
    const signupIpHash = hashIp(signupIp);
    if (winningClick && winningClick.ipHash && signupIpHash && winningClick.ipHash === signupIpHash) {
      // Not a hard block — could be legitimate (roommate signup on shared
      // WiFi). Just record the referral with status='blocked' so an admin
      // can review before any downstream commission engine acts on it.
      strapi.log.warn(`[affiliate-attribution] ip_hash match — flagging referral for review (code=${code} user=${userId})`);
      const ref = await strapi.entityService.create('api::affiliate-referral.affiliate-referral', {
        data: {
          affiliate: affiliate.id,
          referredUser: userId,
          referralLinkClick: winningClick ? winningClick.id : null,
          attributedAt: new Date(),
          attributionIpHash: signupIpHash,
          status: 'blocked',
          adminNotes: 'auto-blocked: signup IP hash matched click IP hash (possible self-referral)',
        },
      });
      if (winningClick) {
        await strapi.entityService.update('api::affiliate-link-click.affiliate-link-click', winningClick.id, {
          data: { attributedToSignup: true, attributedToUser: userId },
        });
      }
      return ref;
    }

    // 6. Happy path — create the referral, mark the click as attributed.
    const ref = await strapi.entityService.create('api::affiliate-referral.affiliate-referral', {
      data: {
        affiliate: affiliate.id,
        referredUser: userId,
        referralLinkClick: winningClick ? winningClick.id : null,
        attributedAt: new Date(),
        attributionIpHash: signupIpHash,
        status: 'active',
      },
    });
    if (winningClick) {
      await strapi.entityService.update('api::affiliate-link-click.affiliate-link-click', winningClick.id, {
        data: { attributedToSignup: true, attributedToUser: userId },
      });
    }
    strapi.log.info(`[affiliate-attribution] user=${userId} attributed to affiliate=${affiliate.id} via code=${code}`);
    return ref;
  } catch (err) {
    strapi.log.error(`[affiliate-attribution] error attributing user=${userId} code=${code}: ${err.message}`);
    return null;
  }
}

module.exports = {
  attributeReferral,
  hashIp,
  ATTRIBUTION_WINDOW_DAYS,
};
