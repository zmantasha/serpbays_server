'use strict';

/**
 * Customer API key check (2026-10-13). Accepts `Authorization: Bearer <key>`
 * or `X-API-Key: <key>`. Answers 401 / 429 itself (JSON), sets rate-limit
 * headers and ctx.state.apiKey, and counts each response for usage stats.
 */
module.exports = (config, { strapi }) => async (ctx, next) => {
  const svc = require('../services/api-keys');
  const fail = (status, code, message) => { ctx.status = status; ctx.body = { error: { code, message } }; };
  ctx.set('Cache-Control', 'no-store');
  const auth = String(ctx.request.header.authorization || '');
  const key = ((auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '') || String(ctx.request.header['x-api-key'] || '')).trim();
  if (!key) return fail(401, 'missing_key', 'Send your API key as "Authorization: Bearer <key>" or "X-API-Key: <key>".');
  let row;
  try { row = await svc.findByKey(key); } catch (e) { strapi.log.error(`[api-key] lookup failed: ${e.message}`); return fail(503, 'unavailable', 'Try again shortly.'); }
  if (!row) return fail(401, 'invalid_key', 'This API key is not valid.');
  const r = await svc.admit(row, ctx.request.ip);
  if (r.headers) for (const [k, v] of Object.entries(r.headers)) ctx.set(k, v);
  if (!r.ok) return fail(r.status, r.code, r.message);
  ctx.state.apiKey = row;
  try {
    await next();
  } catch (e) {
    strapi.log.error(`[api v1] ${ctx.path}: ${e.message}`);
    fail(500, 'server_error', 'Something went wrong on our side.');
  }
  const rows = ctx.body && Array.isArray(ctx.body.data) ? ctx.body.data.length : ctx.body && ctx.body.data ? 1 : 0;
  svc.countResult(row.id, rows, ctx.status >= 400);
};
