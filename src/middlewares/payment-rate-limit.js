'use strict';

/**
 * Rate limiting middleware for payment endpoints
 * Prevents spam and DDoS attacks on critical payment routes
 */

const rateLimit = require('koa-ratelimit');

// Create database for rate limiting
// For production with Redis, install: npm install ioredis
// For development, uses in-memory Map (no Redis needed)
let db;
if (process.env.REDIS_URL) {
    try {
        const Redis = require('ioredis');
        db = new Redis(process.env.REDIS_URL);
        console.log('[RATE LIMIT] Using Redis for rate limiting');
    } catch (error) {
        console.warn('[RATE LIMIT] Redis not available, falling back to in-memory storage');
        db = new Map();
    }
} else {
    db = new Map();
    console.log('[RATE LIMIT] Using in-memory storage for rate limiting');
}

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
    max: 30, // ✅ INCREASED: From 10 to 30 to allow retries during network issues
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
    max: 50, // ✅ INCREASED: From 20 to 50 for better retry support
    disableHeader: false,
});

module.exports = {
    paymentRateLimiter,
    webhookRateLimiter,
    verificationRateLimiter,
};
