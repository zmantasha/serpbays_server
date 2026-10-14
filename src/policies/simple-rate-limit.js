'use strict';

/**
 * A simple in-memory rate limiting policy.
 * WARNING: This is basic and not suitable for distributed environments or if persistence across restarts is needed.
 * For production, consider a robust solution with an external store like Redis.
 *
 * 2026-10-14: counters are per IP *and per route*. Before, every route that used
 * this policy shared one list of timestamps per IP, so a visitor who had made a
 * handful of unrelated requests (clicks, downloads, settings saves) was blocked on
 * a "5 per hour" route such as an application form.
 */

const HITS = new Map(); // key "ip|METHOD path" -> request timestamps
let lastSweep = Date.now();

module.exports = async (policyContext, config, { strapi }) => {
  const { ip } = policyContext.request;
  const { interval = 60000, max = 100 } = config; // Default: 100 requests per 60 seconds

  if (!ip) {
    // Cannot apply rate limiting if IP is not available
    strapi.log.warn('Rate limit policy cannot determine IP address.');
    return true;
  }

  const route = (policyContext.state && policyContext.state.route) || {};
  const key = `${ip}|${route.method || policyContext.request.method} ${route.path || policyContext.request.path}`;
  const now = Date.now();
  const windowStart = now - interval;

  // Get current hits for this IP + route and filter out hits older than the window
  const ipHits = (HITS.get(key) || []).filter((timestamp) => timestamp > windowStart);

  if (ipHits.length >= max) {
    strapi.log.warn(`Rate limit exceeded for ${key}`);
    policyContext.response.status = 429; // Too Many Requests
    policyContext.response.body = {
      error: 'Too many requests, please try again later.',
    };
    return false; // Block the request
  }

  // Add current hit timestamp and update the store
  ipHits.push(now);
  HITS.set(key, ipHits);

  // keep memory bounded on a long-lived process
  if (now - lastSweep > 10 * 60 * 1000) {
    lastSweep = now;
    for (const [k, v] of HITS) if (!v.length || v[v.length - 1] < now - 24 * 60 * 60 * 1000) HITS.delete(k);
  }

  return true; // Allow the request
};
