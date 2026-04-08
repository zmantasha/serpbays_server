'use strict';

/**
 * Global API logger middleware.
 *
 * Captures every non-trivial HTTP request and persists a structured row to
 * the `api-log` collection via the Winston StrapiDbTransport. The middleware
 * is registered immediately after `strapi::errors` so that on the unwind of
 * the Koa onion `ctx.status` and `ctx.body` already reflect any error
 * response that the errors middleware produced from a thrown exception.
 *
 * Safety guarantees:
 *  - The entire `try/finally` body is wrapped in `try/catch` so a logging
 *    failure can NEVER 500 a request.
 *  - Recursion guard: requests under `/api/api-logs` short-circuit before
 *    `next()` is even instrumented (so reading the logs cannot create logs).
 *  - Skip prefixes: admin panel, health checks, uploads, content-manager,
 *    static assets — all bypass the logger entirely.
 *  - Stream-safe: streamed response bodies are recorded as `{ _stream: true }`
 *    rather than drained.
 *  - Toggleable via env (API_LOGGER_ENABLED, API_LOGGER_SKIP_GETS,
 *    API_LOGGER_BODY_MAX_BYTES).
 *
 * Pattern mirrors `src/middlewares/admin-logger.js`.
 */

const crypto = require('crypto');

const apiLogger = require('../utils/logger');
const { redact } = require('../utils/logger/redact');
const { truncateBody } = require('../utils/logger/truncate');

const RECURSION_PREFIX = '/api/api-logs';

const SKIP_PREFIXES = [
  '/admin',
  '/_health',
  '/uploads',
  '/i18n',
  '/content-manager',
  '/content-type-builder',
  '/users-permissions',
  '/api/api-logs',
];

const STATIC_ASSET_RE = /\.(css|js|map|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|webp|bmp|mp4|webm)$/i;

const ENABLED = (process.env.API_LOGGER_ENABLED || 'true').toLowerCase() !== 'false';
const SKIP_GETS = (process.env.API_LOGGER_SKIP_GETS || 'true').toLowerCase() !== 'false';

function shouldSkipPath(path) {
  if (!path) return true;
  for (const prefix of SKIP_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  if (STATIC_ASSET_RE.test(path)) return true;
  return false;
}

function pickLevel(status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

function getRequestId(ctx) {
  const incoming = ctx.request.get('x-request-id');
  if (incoming) return incoming.slice(0, 64);
  return crypto.randomBytes(8).toString('hex');
}

function safeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = { ...headers };
  delete out.authorization;
  delete out.Authorization;
  delete out.cookie;
  delete out.Cookie;
  return out;
}

module.exports = (config, { strapi }) => {
  // Lazily ensure the logger is initialised so the first request can't race
  // with bootstrap. `init()` is idempotent.
  apiLogger.init(strapi);

  return async (ctx, next) => {
    if (!ENABLED) {
      return next();
    }

    const reqPath = ctx.request.path || ctx.url || '';

    // Hard recursion guard — never log calls to the api-logs endpoint itself.
    if (reqPath.startsWith(RECURSION_PREFIX) || shouldSkipPath(reqPath)) {
      return next();
    }

    const requestId = getRequestId(ctx);
    // Surface the request id to the client and downstream middleware.
    ctx.set('X-Request-Id', requestId);
    ctx.state.requestId = requestId;

    const startTime = Date.now();
    let caughtError = null;

    try {
      await next();
    } catch (err) {
      caughtError = err;
      throw err;
    } finally {
      try {
        const status = ctx.status || 0;
        const method = ctx.request.method;
        const isReadGet = method === 'GET' && status >= 200 && status < 400;

        // Skip successful GETs to control volume.
        if (!(SKIP_GETS && isReadGet && !caughtError)) {
          const durationMs = Date.now() - startTime;
          const level = caughtError ? 'error' : pickLevel(status);
          const user = ctx.state.user || null;

          const reqBodyRaw = ctx.request.body ?? null;
          const resBodyRaw = ctx.body ?? null;

          // Redact + truncate.
          const requestBody = truncateBody(redact(reqBodyRaw, { responseOnly: false }));
          const responseBody = truncateBody(redact(resBodyRaw, { responseOnly: true }));

          const headers = safeHeaders(ctx.request.headers);

          const logger = apiLogger.get();
          const payload = {
            message: `${method} ${reqPath} ${status}`,
            method,
            path: reqPath,
            statusCode: status,
            durationMs,
            userId: user?.id ?? null,
            userEmail: user?.email ?? null,
            ip: ctx.request.ip || ctx.ip || null,
            userAgent: ctx.request.get('user-agent') || null,
            requestHeaders: headers,
            requestBody,
            responseBody,
            errorMessage: caughtError?.message || null,
            errorStack: caughtError?.stack || null,
            requestId,
          };

          logger[level] ? logger[level](payload) : logger.info(payload);
        }
      } catch (logErr) {
        try {
          strapi.log.warn(`[api-logger] middleware capture failed: ${logErr.message}`);
        } catch (_e) {
          // give up silently — logging must never break the request
        }
      }
    }
  };
};
