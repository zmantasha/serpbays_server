'use strict';

/**
 * Body capping utility for the API logger.
 *
 * - If the body is a stream (has a `pipe` function), replaces it with
 *   `{ _stream: true }` so we don't drain it and break the response.
 * - If the JSON-stringified body exceeds `maxBytes`, replaces it with
 *   `{ _truncated: true, _originalBytes, preview }` where preview is the
 *   first ~1KB of the stringified body.
 * - On any internal error returns `{ _serializeError: true }` instead of
 *   throwing — logging must never break the request.
 */

const DEFAULT_MAX_BYTES = parseInt(process.env.API_LOGGER_BODY_MAX_BYTES || '10240', 10);
const PREVIEW_BYTES = 1024;

function isStream(body) {
  return body && typeof body === 'object' && typeof body.pipe === 'function';
}

/**
 * @param {any} body
 * @param {number} [maxBytes]
 * @returns {any}
 */
function truncateBody(body, maxBytes = DEFAULT_MAX_BYTES) {
  if (body === null || body === undefined) return body;
  if (isStream(body)) return { _stream: true };

  // Buffer / Uint8Array — record size only.
  if (Buffer.isBuffer(body)) {
    return { _buffer: true, _originalBytes: body.length };
  }

  try {
    // For primitives or objects, measure stringified size.
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    if (json === undefined) return body;
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes <= maxBytes) {
      // Return parsed-form so the JSON column stays structured.
      return typeof body === 'string' ? body : body;
    }
    return {
      _truncated: true,
      _originalBytes: bytes,
      preview: json.slice(0, PREVIEW_BYTES),
    };
  } catch (_e) {
    return { _serializeError: true };
  }
}

module.exports = {
  truncateBody,
  DEFAULT_MAX_BYTES,
};
