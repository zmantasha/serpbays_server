'use strict';

/**
 * StrapiDbTransport
 *
 * Custom Winston transport that persists log entries into the
 * `api::api-log.api-log` collection via `strapi.db.query(...).create()`.
 *
 * Design rules:
 *  - Fire-and-forget: `log()` schedules the write via `setImmediate` and
 *    immediately calls `callback()` so Winston (and the request pipeline)
 *    are never blocked by the DB round-trip.
 *  - Recursion guard: any record whose path starts with `/api/api-logs` is
 *    silently dropped — defense in depth in case the middleware ever forgets.
 *  - Failure isolation: every DB error is swallowed and reported via
 *    `strapi.log.warn(...)` so a logging hiccup cannot cascade into the
 *    request that produced it.
 */

const Transport = require('winston-transport');

const RECURSION_PREFIX = '/api/api-logs';
const MAX_PATH_LEN = 512;
const MAX_USER_AGENT_LEN = 1024;

class StrapiDbTransport extends Transport {
  constructor(opts = {}) {
    super(opts);
    this.name = 'strapi-db';
    this._strapiRef = opts.strapiRef || null;
  }

  setStrapi(strapi) {
    this._strapiRef = strapi;
  }

  log(info, callback) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    // Schedule the actual DB write asynchronously and never await it.
    setImmediate(() => this._writeToDb(info));

    if (typeof callback === 'function') callback();
  }

  async _writeToDb(info) {
    const strapi = this._strapiRef || global.strapi;
    if (!strapi) return;

    try {
      const path = info.path || '';
      // Defense-in-depth recursion guard.
      if (typeof path === 'string' && path.startsWith(RECURSION_PREFIX)) return;

      // Hard-cap fields that map to varchar columns to avoid driver errors.
      const safePath = typeof path === 'string' ? path.slice(0, MAX_PATH_LEN) : null;
      const safeUa = typeof info.userAgent === 'string'
        ? info.userAgent.slice(0, MAX_USER_AGENT_LEN)
        : null;

      const data = {
        level: info.level || 'info',
        method: info.method || null,
        path: safePath,
        statusCode: typeof info.statusCode === 'number' ? info.statusCode : null,
        durationMs: typeof info.durationMs === 'number' ? info.durationMs : null,
        userId: typeof info.userId === 'number' ? info.userId : null,
        userEmail: info.userEmail || null,
        ip: info.ip || null,
        userAgent: safeUa,
        requestBody: info.requestBody ?? null,
        responseBody: info.responseBody ?? null,
        errorMessage: info.errorMessage || null,
        errorStack: info.errorStack || null,
        requestId: info.requestId || null,
      };

      await strapi.db.query('api::api-log.api-log').create({ data });
    } catch (err) {
      try {
        // Use strapi.log here, NOT the api logger, to avoid recursion.
        strapi?.log?.warn(`[api-logger] failed to persist log row: ${err.message}`);
      } catch (_e) {
        // give up silently
      }
    }
  }
}

module.exports = StrapiDbTransport;
