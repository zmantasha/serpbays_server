'use strict';

/**
 * Rate limiting middleware for payment endpoints
 * Prevents spam and DDoS attacks on critical payment routes
 */

const rateLimit = require('koa-ratelimit');
const Redis = require('ioredis');

// Create Redis client for rate limiting (can also use in-memory Map)
// For production, use Redis. For development, in-memory is fine.
const db = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL)
    : new Map();

/**
 * Payment endpoint rate limiter
 * Limits: 10 requests per minute per user
 */
const paymentRateLimiter = rateLimit({
    driver: process.env.REDIS_URL ? 'redis' : 'memory',
    db: db,
    duration: 60000, // 1 minute in milliseconds
    errorMessage: 'Too many payment requests. Please try again in a minute.',
    id: (ctx) => {
        // Use user ID if authenticated, otherwise IP address
        const userId = ctx.state?.user?.id;
        return userId ? `user:${userId}` : ctx.ip;
    },
    headers: {
        remaining: 'Rate-Limit-Remaining',
        reset: 'Rate-Limit-Reset',
        total: 'Rate-Limit-Total',
    },
    max: 10, // Maximum 10 requests per minute
    disableHeader: false,
    whitelist: (ctx) => {
        // No whitelist - apply to all users
        return false;
    },
    blacklist: (ctx) => {
        // Can add IP blacklist here if needed
        return false;
    },
});

/**
 * Webhook rate limiter (more lenient)
 * Webhooks come from payment gateways, not users
 * Limits: 100 requests per minute per gateway
 */
const webhookRateLimiter = rateLimit({
    driver: process.env.REDIS_URL ? 'redis' : 'memory',
    db: db,
    duration: 60000,
    errorMessage: 'Webhook rate limit exceeded',
    id: (ctx) => {
        // Use gateway name from URL
        return `webhook:${ctx.params.gateway || 'unknown'}`;
    },
    max: 100, // More lenient for webhooks
    disableHeader: false,
});

/**
 * Strict rate limiter for verification endpoints
 * Limits: 20 requests per minute per user
 */
const verificationRateLimiter = rateLimit({
    driver: process.env.REDIS_URL ? 'redis' : 'memory',
    db: db,
    duration: 60000,
    errorMessage: 'Too many verification requests. Please try again in a minute.',
    id: (ctx) => {
        const userId = ctx.state?.user?.id;
        return userId ? `verify:user:${userId}` : `verify:ip:${ctx.ip}`;
    },
    max: 20,
    disableHeader: false,
});

module.exports = {
    paymentRateLimiter,
    webhookRateLimiter,
    verificationRateLimiter,
};
