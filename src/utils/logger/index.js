'use strict';

/**
 * API logger singleton.
 *
 * Wraps a Winston logger with two transports:
 *  - Console (pretty in dev, JSON in prod) so PM2 logs continue to capture
 *    the same data as before.
 *  - StrapiDbTransport that persists each entry into the `api-log` collection.
 *
 * Initialised once during Strapi bootstrap (`init(strapi)`); accessed via
 * `get()` from the api-logger middleware. If `init()` has not been called
 * yet (e.g. very early boot), `get()` returns a no-op shim so callers never
 * crash.
 */

const winston = require('winston');
const StrapiDbTransport = require('./strapi-db-transport');

let _logger = null;
let _dbTransport = null;

const NOOP = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function buildConsoleFormat() {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    return winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    );
  }
  return winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf((info) => {
      const { timestamp, level, message, method, path, statusCode, durationMs } = info;
      const meta = method && path ? ` ${method} ${path} ${statusCode || ''} ${durationMs ?? ''}ms` : '';
      return `[${timestamp}] [api] ${level}: ${message || ''}${meta}`;
    })
  );
}

function init(strapi) {
  if (_logger) {
    // Allow re-init to update strapi reference (useful in dev hot-reload).
    if (_dbTransport) _dbTransport.setStrapi(strapi);
    return _logger;
  }

  const enabled = (process.env.API_LOGGER_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    _logger = NOOP;
    return _logger;
  }

  const level = process.env.API_LOGGER_LEVEL || 'info';
  const dbEnabled = (process.env.API_LOGGER_DB_ENABLED || 'true').toLowerCase() !== 'false';

  const transports = [
    new winston.transports.Console({
      level,
      format: buildConsoleFormat(),
    }),
  ];

  if (dbEnabled) {
    _dbTransport = new StrapiDbTransport({ level, strapiRef: strapi });
    transports.push(_dbTransport);
  }

  _logger = winston.createLogger({
    level,
    transports,
    exitOnError: false,
  });

  return _logger;
}

function get() {
  return _logger || NOOP;
}

module.exports = {
  init,
  get,
};
