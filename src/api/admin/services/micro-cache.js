'use strict';

/**
 * Tiny in-process response cache for heavy read-only admin endpoints
 * (dashboard, analytics). 2026-10-13 (perf).
 *
 * - Entries live for `ttlMs`; `?fresh=1` skips the cache.
 * - Parallel misses for the same key share one computation, so ten admins
 *   opening the dashboard at once run the ~45 queries once, not ten times.
 * - Only 200 responses are stored. Responses get `cached: true` and
 *   `cacheAgeSec` so the UI can say how old the numbers are.
 */

const store = new Map(); // key -> { at, body }
const inflight = new Map(); // key -> Promise<body|null>
const MAX_KEYS = 200;

function get(key, ttlMs) {
  const e = store.get(key);
  return e && Date.now() - e.at < ttlMs ? e : null;
}

function set(key, body) {
  if (store.size >= MAX_KEYS) store.delete(store.keys().next().value);
  store.set(key, { at: Date.now(), body });
}

/** Value-level cache: memo(key, ttlMs, fn) → cached result of fn(). */
async function memo(key, ttlMs, fn) {
  const hit = get(key, ttlMs);
  if (hit) return hit.body;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try { const v = await fn(); set(key, v); return v; } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

/** Wrap a controller action: serve(ctx, key, ttlMs, impl). */
async function serve(ctx, key, ttlMs, impl) {
  const fresh = String((ctx.query && ctx.query.fresh) || '') === '1';
  if (!fresh) {
    const hit = get(key, ttlMs);
    if (hit) return ctx.send({ ...hit.body, cached: true, cacheAgeSec: Math.round((Date.now() - hit.at) / 1000) });
    if (inflight.has(key)) {
      const body = await inflight.get(key).catch(() => null);
      if (body) return ctx.send({ ...body, cached: true, cacheAgeSec: 0 });
    }
  }
  const p = (async () => {
    await impl(ctx);
    const ok = (ctx.status || 200) === 200 && ctx.body && typeof ctx.body === 'object';
    return ok ? ctx.body : null;
  })();
  inflight.set(key, p);
  try {
    const body = await p;
    if (body) set(key, body);
  } finally {
    inflight.delete(key);
  }
}

function del(key) { store.delete(key); }

module.exports = { serve, memo, get, set, del };
