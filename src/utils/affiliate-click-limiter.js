'use strict';

/**
 * Rate limiter for the public affiliate click-tracking endpoint.
 *
 * Threat model: `POST /api/affiliate-tracking/click` is auth:false — anyone
 * on the internet can hit it. Without throttling:
 *   - A hostile client could flood the endpoint with junk clicks, inflating
 *     an affiliate's analytics and burying real conversions.
 *   - The same host could enumerate referral codes: brute-forcing 10-char
 *     base32 is infeasible (10¹⁵), but a well-targeted attempt to check
 *     "does code X exist" could be a fraud precursor.
 *
 * Two layers:
 *   1. Per-IP cap — 200 clicks/hour. Higher than promo-redeem-limiter's
 *      per-IP cap because a legitimate affiliate campaign can drive real
 *      per-IP volume behind NAT / campus WiFi / corporate proxies.
 *   2. Per-code cap — 500 clicks/hour on any single code. Not a per-IP
 *      metric; if ONE code is being hammered from many IPs (bot swarm),
 *      throttle at the code level so the affiliate's honest traffic isn't
 *      completely degraded from other angles.
 *
 * Redis-backed via global.strapi.io_redis.pubClient with an in-memory Map
 * fallback for single-pod dev.
 *
 * Tunable via env vars:
 *   AFFILIATE_CLICK_IP_LIMIT       (default 200)
 *   AFFILIATE_CLICK_IP_WINDOW_S    (default 3600)
 *   AFFILIATE_CLICK_CODE_LIMIT     (default 500)
 *   AFFILIATE_CLICK_CODE_WINDOW_S  (default 3600)
 */

const num = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const IP_LIMIT      = () => num('AFFILIATE_CLICK_IP_LIMIT', 200);
const IP_WINDOW_S   = () => num('AFFILIATE_CLICK_IP_WINDOW_S', 3600);
const CODE_LIMIT    = () => num('AFFILIATE_CLICK_CODE_LIMIT', 500);
const CODE_WINDOW_S = () => num('AFFILIATE_CLICK_CODE_WINDOW_S', 3600);

const memCounters = new Map();

const getRedis = () => global.strapi?.io_redis?.pubClient || null;

const incrAndExpire = async (key, windowS) => {
  const client = getRedis();
  if (client) {
    try {
      const n = await client.incr(key);
      if (n === 1) await client.expire(key, windowS);
      return n;
    } catch (err) {
      global.strapi?.log?.warn?.(`[affiliate-click-limiter] redis incr failed: ${err.message}`);
    }
  }
  const now = Date.now();
  const entry = memCounters.get(key);
  if (!entry || entry.expiresAt < now) {
    memCounters.set(key, { count: 1, expiresAt: now + windowS * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
};

const ipKey   = (ip)   => `aff:click:ip:${ip}`;
const codeKey = (code) => `aff:click:code:${code}`;

module.exports = {
  /**
   * Call BEFORE recording the click. Returns:
   *   { allowed: true }
   *   { allowed: false, reason: 'ip_limit' | 'code_limit', retryAfterSeconds: N }
   *
   * Both counters are incremented on every call — the caller doesn't
   * distinguish valid-code vs invalid-code, so an attacker can't drive
   * a different counter by supplying garbage codes.
   */
  async check(ipAddress, referralCode) {
    if (ipAddress) {
      const n = await incrAndExpire(ipKey(ipAddress), IP_WINDOW_S());
      if (n > IP_LIMIT()) {
        return { allowed: false, reason: 'ip_limit', retryAfterSeconds: IP_WINDOW_S() };
      }
    }
    if (referralCode) {
      const n = await incrAndExpire(codeKey(referralCode), CODE_WINDOW_S());
      if (n > CODE_LIMIT()) {
        return { allowed: false, reason: 'code_limit', retryAfterSeconds: CODE_WINDOW_S() };
      }
    }
    return { allowed: true };
  },

  limits() {
    return {
      ipLimit:      IP_LIMIT(),
      ipWindowS:    IP_WINDOW_S(),
      codeLimit:    CODE_LIMIT(),
      codeWindowS:  CODE_WINDOW_S(),
    };
  },
};
