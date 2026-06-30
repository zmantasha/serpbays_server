'use strict';

/**
 * Per-user / per-IP brute-force limiter for promo-code redemption.
 *
 * Threat model: an authenticated user can call `POST /api/wallet/redeem-promo`
 * (or `/api/api/wallet/redeem-promo`) with a candidate code. Without throttling,
 * a hostile caller can iterate through short codes (or partial dictionary
 * matches) to collect free credits — especially worrying if any promo code
 * is < 8 characters or has a guessable format (e.g. `WELCOME10`, `LAUNCH50`).
 *
 * Three layers:
 *   1. ATTEMPT cap per user (any outcome): a user can call the endpoint at
 *      most ATTEMPT_LIMIT times per ATTEMPT_WINDOW. Prevents script-driven
 *      enumeration.
 *   2. FAILURE cap per user (failed redemptions only): after FAILURE_LIMIT
 *      bad codes in FAILURE_WINDOW, the user is locked out of redeem-promo
 *      for FAILURE_COOLDOWN. Successful redemptions don't count.
 *   3. ATTEMPT cap per source IP: prevents a single host running many
 *      compromised accounts from sweeping the namespace.
 *
 * All counters live in Redis when REDIS_URL is set (shared across pods,
 * survives pod restarts). Falls back to an in-memory Map for single-pod
 * dev — acceptable because dev rarely needs cross-pod consistency.
 *
 * Tunable via env vars:
 *   PROMO_REDEEM_ATTEMPT_LIMIT     (default 10)
 *   PROMO_REDEEM_ATTEMPT_WINDOW_S  (default 3600 = 1h)
 *   PROMO_REDEEM_FAILURE_LIMIT     (default 5)
 *   PROMO_REDEEM_FAILURE_WINDOW_S  (default 1800 = 30m)
 *   PROMO_REDEEM_FAILURE_COOLDOWN_S (default 1800 = 30m)
 *   PROMO_REDEEM_IP_LIMIT          (default 30)
 *   PROMO_REDEEM_IP_WINDOW_S       (default 3600 = 1h)
 */

const num = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const ATTEMPT_LIMIT     = () => num('PROMO_REDEEM_ATTEMPT_LIMIT', 10);
const ATTEMPT_WINDOW_S  = () => num('PROMO_REDEEM_ATTEMPT_WINDOW_S', 3600);
const FAILURE_LIMIT     = () => num('PROMO_REDEEM_FAILURE_LIMIT', 5);
const FAILURE_WINDOW_S  = () => num('PROMO_REDEEM_FAILURE_WINDOW_S', 1800);
const FAILURE_COOLDOWN_S = () => num('PROMO_REDEEM_FAILURE_COOLDOWN_S', 1800);
const IP_LIMIT          = () => num('PROMO_REDEEM_IP_LIMIT', 30);
const IP_WINDOW_S       = () => num('PROMO_REDEEM_IP_WINDOW_S', 3600);

// In-memory fallback. Map<bucket-key, { count, expiresAt }>.
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
      global.strapi?.log?.warn?.(`[promo-redeem-limiter] redis incr failed: ${err.message}`);
    }
  }
  // Fallback to memory.
  const now = Date.now();
  const entry = memCounters.get(key);
  if (!entry || entry.expiresAt < now) {
    memCounters.set(key, { count: 1, expiresAt: now + windowS * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
};

const get = async (key) => {
  const client = getRedis();
  if (client) {
    try {
      const v = await client.get(key);
      return v == null ? 0 : Number.parseInt(v, 10) || 0;
    } catch (err) {
      global.strapi?.log?.warn?.(`[promo-redeem-limiter] redis get failed: ${err.message}`);
    }
  }
  const entry = memCounters.get(key);
  if (!entry) return 0;
  if (entry.expiresAt < Date.now()) {
    memCounters.delete(key);
    return 0;
  }
  return entry.count;
};

const userAttemptKey  = (uid) => `promo:attempt:user:${uid}`;
const userFailureKey  = (uid) => `promo:failure:user:${uid}`;
const userCooldownKey = (uid) => `promo:cooldown:user:${uid}`;
const ipAttemptKey    = (ip)  => `promo:attempt:ip:${ip}`;

module.exports = {
  /**
   * Call BEFORE processing the redemption. Returns:
   *   { allowed: true }
   *   { allowed: false, reason: 'cooldown' | 'attempt_limit' | 'ip_limit',
   *     retryAfterSeconds: N }
   *
   * Counts toward the attempt limit unconditionally — this is the "burst"
   * defense. The failure limit is incremented separately via `recordFailure`
   * AFTER the redemption fails.
   */
  async check(userId, ipAddress) {
    if (!Number.isInteger(userId) || userId <= 0) {
      return { allowed: false, reason: 'unauthenticated', retryAfterSeconds: 0 };
    }

    // Active cooldown wins immediately — no further increments.
    const cooldown = await get(userCooldownKey(userId));
    if (cooldown > 0) {
      return { allowed: false, reason: 'cooldown', retryAfterSeconds: FAILURE_COOLDOWN_S() };
    }

    const attempts = await incrAndExpire(userAttemptKey(userId), ATTEMPT_WINDOW_S());
    if (attempts > ATTEMPT_LIMIT()) {
      return { allowed: false, reason: 'attempt_limit', retryAfterSeconds: ATTEMPT_WINDOW_S() };
    }

    if (ipAddress) {
      const ipAttempts = await incrAndExpire(ipAttemptKey(ipAddress), IP_WINDOW_S());
      if (ipAttempts > IP_LIMIT()) {
        return { allowed: false, reason: 'ip_limit', retryAfterSeconds: IP_WINDOW_S() };
      }
    }

    return { allowed: true };
  },

  /**
   * Call AFTER a failed redemption (invalid code, expired, exhausted, etc).
   * Once the failure-count breaches FAILURE_LIMIT in FAILURE_WINDOW, the
   * user is placed in a cooldown for FAILURE_COOLDOWN.
   */
  async recordFailure(userId) {
    if (!Number.isInteger(userId) || userId <= 0) return;
    const failures = await incrAndExpire(userFailureKey(userId), FAILURE_WINDOW_S());
    if (failures >= FAILURE_LIMIT()) {
      await incrAndExpire(userCooldownKey(userId), FAILURE_COOLDOWN_S());
      global.strapi?.log?.warn?.(
        `[promo-redeem-limiter] user ${userId} entered cooldown after ${failures} failures`
      );
    }
  },

  /**
   * Returns the configured limits — used by callers to format informative
   * error responses without hard-coding values that may have been overridden
   * by env vars.
   */
  limits() {
    return {
      attemptLimit:    ATTEMPT_LIMIT(),
      attemptWindowS:  ATTEMPT_WINDOW_S(),
      failureLimit:    FAILURE_LIMIT(),
      failureWindowS:  FAILURE_WINDOW_S(),
      failureCooldownS: FAILURE_COOLDOWN_S(),
      ipLimit:         IP_LIMIT(),
      ipWindowS:       IP_WINDOW_S(),
    };
  },
};
