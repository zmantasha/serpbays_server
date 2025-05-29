'use strict';

/**
 * A simple in-memory rate limiting policy.
 * WARNING: This is basic and not suitable for distributed environments or if persistence across restarts is needed.
 * For production, consider a robust solution with an external store like Redis.
 */

const HITS = new Map(); // Stores IP addresses and their request timestamps

module.exports = async (policyContext, config, { strapi }) => {
  const { ip } = policyContext.request;
  const { interval = 60000, max = 100 } = config; // Default: 100 requests per 60 seconds

  if (!ip) {
    // Cannot apply rate limiting if IP is not available
    strapi.log.warn('Rate limit policy cannot determine IP address.');
    return true; 
  }

  const now = Date.now();
  const windowStart = now - interval;

  // Get current hits for this IP and filter out hits older than the window
  const ipHits = (HITS.get(ip) || []).filter(timestamp => timestamp > windowStart);

  if (ipHits.length >= max) {
    strapi.log.warn(`Rate limit exceeded for IP: ${ip}`);
    policyContext.response.status = 429; // Too Many Requests
    policyContext.response.body = {
      error: 'Too many requests, please try again later.',
    };
    return false; // Block the request
  }

  // Add current hit timestamp and update the store
  ipHits.push(now);
  HITS.set(ip, ipHits);
  
  return true; // Allow the request
}; 