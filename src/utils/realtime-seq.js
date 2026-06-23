'use strict';

/**
 * Cross-pod monotonic sequence numbers for realtime event payloads.
 *
 * The wallet / order / withdrawal / bank-transfer emit helpers each tag
 * their payload with a per-user `seq` so the client can drop out-of-order
 * events (reconnect storms, pub/sub reorder). The original implementation
 * used a per-process in-memory Map<userId, lastSeq>, which has two failure
 * modes once you run more than one pod:
 *
 *   1. Two pods independently generate seq=1 for the same user → the
 *      client receives seq=1 twice with different payloads; the second
 *      arrival is rejected as stale.
 *   2. On Strapi restart, the Map resets to 0 — the client's lastSeq is
 *      still 17, every new event looks stale until it climbs back past 17.
 *
 * This helper centralizes the seq logic and prefers Redis INCR when
 * available (a single shared atomic counter, durable across restarts).
 * On REDIS_URL-not-set or Redis-down, falls back to the in-memory Map so
 * single-pod dev keeps working.
 *
 * Usage:
 *   const seq = require('../../../utils/realtime-seq')('wallet');
 *   const n = await seq.next(userId);
 *
 * Each caller passes a unique `channel` string ('wallet', 'order', etc.)
 * so the Redis keys don't collide (wallet:seq:42 vs order:seq:42).
 *
 * NOTE: the Redis call adds ~1ms round-trip; emit helpers are best-effort
 * and tolerate this. If Redis becomes a bottleneck (unlikely for this
 * volume), drop the await — the Map fallback returns synchronously.
 */

const inMemorySeqByChannel = new Map(); // channel → Map<userId, lastSeq>

const getMap = (channel) => {
  if (!inMemorySeqByChannel.has(channel)) {
    inMemorySeqByChannel.set(channel, new Map());
  }
  return inMemorySeqByChannel.get(channel);
};

const nextInMemory = (channel, userId) => {
  const map = getMap(channel);
  const cur = (map.get(userId) || 0) + 1;
  map.set(userId, cur);
  return cur;
};

const nextRedis = async (channel, userId) => {
  const client = global.strapi?.io_redis?.pubClient;
  if (!client) return null;
  // INCR is atomic — no race between pods. Key shape `rt:seq:<channel>:<uid>`
  // groups all realtime seq keys under a single namespace for easy
  // `redis-cli SCAN 'rt:seq:*'` inspection during ops debugging.
  return await client.incr(`rt:seq:${channel}:${userId}`);
};

module.exports = (channel) => ({
  /**
   * Generate the next seq for (channel, userId). Resolves to a positive
   * integer. Returns the in-memory counter if Redis isn't configured,
   * the Redis INCR otherwise. Best-effort on Redis failure — falls back
   * to in-memory so an emit is never lost.
   */
  async next(userId) {
    const uid = Number.parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid <= 0) return 0;
    try {
      const fromRedis = await nextRedis(channel, uid);
      if (typeof fromRedis === 'number' && fromRedis > 0) return fromRedis;
    } catch (err) {
      // Don't poison the emit on Redis hiccups; fall through to memory.
      global.strapi?.log?.warn?.(`[realtime-seq:${channel}] redis INCR failed: ${err.message}`);
    }
    return nextInMemory(channel, uid);
  },
});
