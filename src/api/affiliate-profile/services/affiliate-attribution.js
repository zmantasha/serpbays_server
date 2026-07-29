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
 *   - Self-referral fraud detection:
 *       (a) HARD block if referredUser.id === affiliate.user.id
 *       (b) HARD block if referredUser.email === affiliate.user.email (ci)
 *       (c) SOFT flag (pending_review) if signup IP hash matches the
 *           affiliate's OWN recent activity IP hash (see below).
 *
 *     Note: the older design compared the referred user's click IP hash
 *     to their own signup IP hash. Every legitimate single-device signup
 *     matches — the user clicks a link on their phone, fills the form
 *     on the same phone, so of course both requests share an IP. That
 *     produced a 100% false-positive rate. The corrected check compares
 *     the signup IP against the AFFILIATE's last known IP (see
 *     `updateAffiliateActivityIp` in this file), which is the actual
 *     self-referral signal: is the affiliate logged in on the same
 *     device as the "new" signup?
 *
 *   - 24h staleness window on the affiliate's IP hash — an affiliate
 *     who was last active a month ago shouldn't false-positive-flag a
 *     legit signup that happens to come from a similar carrier NAT.
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

// How recent must the affiliate's own activity be for a same-IP match to
// count as a self-referral signal? Beyond this, IPs are unreliable (dynamic
// ISPs, mobile carrier switches, roaming) and comparing would false-flag.
const AFFILIATE_ACTIVITY_STALENESS_MS = () =>
  num('AFFILIATE_SELF_REFERRAL_STALENESS_HOURS', 24) * 60 * 60 * 1000;

const IP_HASH_SALT = () =>
  process.env.AFFILIATE_IP_HASH_SALT || process.env.APP_KEYS?.split(',')[0] || 'change-me-in-env';

const hashIp = (ip) => {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip) + '|' + IP_HASH_SALT()).digest('hex');
};

/**
 * Opportunistically refresh the affiliate's last-known IP hash. Called
 * from every /affiliates/me/* endpoint that an authenticated affiliate
 * hits. One tiny UPDATE per dashboard visit; keeps the anti-self-referral
 * check honest without polluting hot paths.
 *
 * Silently swallows every failure — the affiliate must not experience an
 * error from this bookkeeping-only write.
 */
async function updateAffiliateActivityIp(strapi, userId, ip) {
  try {
    if (!Number.isInteger(userId) || userId <= 0) return;
    const ipHash = hashIp(ip);
    if (!ipHash) return;
    const profile = await strapi.db.query('api::affiliate-profile.affiliate-profile').findOne({
      where: { user: userId },
      select: ['id', 'lastActivityIpHash'],
    });
    if (!profile) return;
    // Skip the write if the hash hasn't changed — most requests hit this
    // path with an unchanged IP. Also skip if it's within the last 5 min
    // (avoids one DB write per API call under active dashboard use).
    if (profile.lastActivityIpHash === ipHash) return;
    await strapi.entityService.update(
      'api::affiliate-profile.affiliate-profile',
      profile.id,
      { data: { lastActivityIpHash: ipHash, lastActivityAt: new Date() } },
    );
  } catch (err) {
    strapi.log?.warn?.(`[affiliate-attribution] updateAffiliateActivityIp swallowed: ${err.message}`);
  }
}

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

    // 5. Self-referral signal — signup IP matches the AFFILIATE'S recent
    //    activity IP.
    //
    //    The intent is to catch "affiliate is logged in on this device
    //    right now, and someone from the same IP is signing up as a
    //    'referred user'." That's the genuine self-referral pattern.
    //
    //    We used to compare click.ipHash to signup.ipHash — but that was
    //    the SAME PERSON's click and signup, so it always matched (a user
    //    clicking a link on their phone then filling the form on the same
    //    phone is exactly what a legitimate referral looks like).
    //    Result was a 100% false-positive rate on staging (users 968,
    //    971, 974, 982, 984 all pending_review). Removed.
    //
    //    Precondition: affiliate must have been active within the
    //    staleness window (24h default). Older IPs are unreliable —
    //    mobile carriers, ISP DHCP renewals, etc.
    //
    //    HARD blocks that short-circuit above without creating a row:
    //      - referredUser.id === affiliate.user.id  (§2, above)
    //      - referredUser.email === affiliate.user.email (case-insensitive, §2)
    const signupIpHash = hashIp(signupIp);
    const stalenessMs = AFFILIATE_ACTIVITY_STALENESS_MS();
    const affiliateActivityAgeMs = affiliate.lastActivityAt
      ? Date.now() - new Date(affiliate.lastActivityAt).getTime()
      : Infinity;
    const affiliateActivityFresh = affiliateActivityAgeMs <= stalenessMs;
    const affiliateIpMatchesSignup = Boolean(
      signupIpHash &&
      affiliate.lastActivityIpHash &&
      affiliate.lastActivityIpHash === signupIpHash &&
      affiliateActivityFresh,
    );

    if (affiliateIpMatchesSignup) {
      strapi.log.warn(
        `[affiliate-attribution] SELF-REFERRAL signal: signup IP matches affiliate's own recent activity IP — flagging for review (code=${code} user=${userId} affiliate=${affiliate.id})`,
      );
      const ref = await strapi.entityService.create('api::affiliate-referral.affiliate-referral', {
        data: {
          affiliate: affiliate.id,
          referredUser: userId,
          referralLinkClick: winningClick ? winningClick.id : null,
          attributedAt: new Date(),
          attributionIpHash: signupIpHash,
          status: 'pending_review',
          blockReason: 'self_referral_same_ip',
          adminNotes: `auto-flagged for review: signup IP hash matches the affiliate's own recent activity IP hash (affiliate active ${Math.round(affiliateActivityAgeMs / 60000)}m ago from same IP). Could be legit (family / office / same-device sharing) — verify email + device + deposit pattern before approving.`,
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
  updateAffiliateActivityIp,
  hashIp,
  ATTRIBUTION_WINDOW_DAYS,
};
