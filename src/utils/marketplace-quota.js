'use strict';

/**
 * Per-user daily marketplace uniqueness quota.
 *
 * Bounds the TOTAL number of distinct marketplace listings a single
 * user can see in a 24-hour window, regardless of how slowly or
 * cleverly they request. This closes the bulk-extraction gap that
 * rate-limits + pageSize caps alone cannot — a scraper that respects
 * rate limits can still extract the entire catalog given enough time.
 *
 * Detection model:
 *   - Track unique marketplace IDs in a Redis SET, key per (userId, day)
 *   - SET cardinality (SCARD) = unique listings viewed today
 *   - On each /api/marketplaces response, attempt to SADD each entry's ID
 *   - If user is AT cap, only IDs already in the SET are kept in the
 *     response — they can re-view what they've seen, but no new IDs slip
 *     through
 *   - Set TTL = 24h (rolling window from first add of the day)
 *
 * Bypass paths (no quota applied):
 *   - Admin role (admin / super_admin)
 *   - Publisher viewing their own listings (caller is filtered to
 *     publisher = user.id upstream; not browsing competitor inventory)
 *   - Anonymous (already 403'd at the route layer)
 *
 * Falls back to an in-memory Map per process if Redis is unavailable —
 * meaning the quota is per-pod in that mode (acceptable single-pod dev).
 * In production with REDIS_URL set, the quota is consistent across pods
 * (single shared SET per user-day).
 *
 * Sizing:
 *   Default cap = 200 unique listings per user per UTC day.
 *   Legit browsers typically view 30-100 listings before making a
 *   decision; scrapers want everything. 200 leaves comfortable headroom
 *   for power users while making catalog enumeration take days/weeks.
 *   Override via MARKETPLACE_DAILY_BROWSE_CAP env var.
 */

const inMemoryQuota = new Map(); // "<userId>:<YYYY-MM-DD>" → Set<marketplaceId>
const inMemoryExpiry = new Map(); // same key → epoch-ms when entry expires

const TTL_SECONDS = 86400; // 24h rolling

const getCap = () => {
  const v = parseInt(process.env.MARKETPLACE_DAILY_BROWSE_CAP, 10);
  return Number.isFinite(v) && v > 0 && v <= 100000 ? v : 200;
};

const todayKey = () => {
  // YYYY-MM-DD in UTC. Bucket boundary at UTC midnight; consistent
  // across servers in different timezones.
  const d = new Date();
  return d.toISOString().slice(0, 10);
};

const getRedisClient = () => global.strapi?.io_redis?.pubClient || null;

// Pure Redis path. Returns null on any failure so caller can fall
// through to the in-memory implementation.
const redisCheckAndFilter = async (userId, candidateIds, cap) => {
  const client = getRedisClient();
  if (!client) return null;
  const key = `mp:browsed:${userId}:${todayKey()}`;
  const idStrs = candidateIds.map(String);
  try {
    const seenCount = await client.scard(key);

    if (seenCount >= cap) {
      // User at quota — only allow IDs already in the SET (re-view).
      // No new IDs added; the SET stays exactly cap-large.
      if (idStrs.length === 0) {
        return { allowed: [], total: seenCount, atQuota: true };
      }
      const memberships = await Promise.all(
        idStrs.map((id) => client.sismember(key, id))
      );
      const allowed = candidateIds.filter((_, i) => memberships[i] === 1);
      return { allowed, total: seenCount, atQuota: true };
    }

    // Under cap. Add new IDs up to the remaining budget; re-allow any
    // already-seen IDs even past the cap.
    const remaining = cap - seenCount;
    if (idStrs.length <= remaining) {
      // All fit
      if (idStrs.length > 0) {
        await client.sadd(key, ...idStrs);
        await client.expire(key, TTL_SECONDS);
      }
      return {
        allowed: candidateIds,
        total: seenCount + idStrs.length,
        atQuota: seenCount + idStrs.length >= cap,
      };
    }

    // Will hit cap mid-response. Add the first `remaining` new IDs.
    // The rest: allow only if already in SET (re-view).
    const newIds = idStrs.slice(0, remaining);
    const overflowIds = idStrs.slice(remaining);
    const newCandidates = candidateIds.slice(0, remaining);
    const overflowCandidates = candidateIds.slice(remaining);
    const overflowMemberships = await Promise.all(
      overflowIds.map((id) => client.sismember(key, id))
    );
    const overflowAllowed = overflowCandidates.filter(
      (_, i) => overflowMemberships[i] === 1
    );
    if (newIds.length > 0) {
      await client.sadd(key, ...newIds);
      await client.expire(key, TTL_SECONDS);
    }
    return {
      allowed: [...newCandidates, ...overflowAllowed],
      total: cap,
      atQuota: true,
    };
  } catch (err) {
    global.strapi?.log?.warn?.(
      `[marketplace-quota] redis failure (fallback to in-memory): ${err.message}`
    );
    return null;
  }
};

// In-memory fallback. Per-process — multi-pod deployments without Redis
// will have inconsistent per-pod counts; acceptable for dev, not prod.
const memoryCheckAndFilter = (userId, candidateIds, cap) => {
  const key = `${userId}:${todayKey()}`;
  const now = Date.now();
  // Lazy expire
  const expiry = inMemoryExpiry.get(key);
  if (expiry && expiry < now) {
    inMemoryQuota.delete(key);
    inMemoryExpiry.delete(key);
  }
  let seen = inMemoryQuota.get(key);
  if (!seen) {
    seen = new Set();
    inMemoryQuota.set(key, seen);
    inMemoryExpiry.set(key, now + TTL_SECONDS * 1000);
  }
  const allowed = [];
  for (const id of candidateIds) {
    if (seen.has(id)) {
      allowed.push(id); // already seen — re-view always allowed
    } else if (seen.size < cap) {
      seen.add(id);
      allowed.push(id);
    }
    // else: drop (over cap + not previously seen)
  }
  return { allowed, total: seen.size, atQuota: seen.size >= cap };
};

module.exports = {
  getCap,
  TTL_SECONDS,

  /**
   * Given a user id and the marketplace IDs that would be in the response,
   * returns the subset the user is allowed to see + quota meta.
   *
   * Returns: { allowed: Array, total: number, atQuota: boolean }
   *
   * Caller MUST bypass for admins / publishers viewing own listings /
   * anonymous (no userId).
   */
  async checkAndFilter(userId, candidateIds) {
    if (!Number.isInteger(userId) || userId <= 0) {
      return { allowed: candidateIds, total: 0, atQuota: false };
    }
    if (!Array.isArray(candidateIds)) {
      return { allowed: [], total: 0, atQuota: false };
    }
    const cap = getCap();
    const redisResult = await redisCheckAndFilter(userId, candidateIds, cap);
    if (redisResult) return redisResult;
    return memoryCheckAndFilter(userId, candidateIds, cap);
  },
};
