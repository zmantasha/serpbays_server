'use strict';

/**
 * Admin audit trail (2026-10-13).
 *
 * Writes one admin_audit_logs row for every successful change made through
 * /api/admin (POST/PUT/PATCH/DELETE): who, what (e.g. "withdrawals.approve"),
 * which record, and a redacted, truncated copy of the request body. Before
 * this, withdrawals, site approvals, user blocks, codes, order edits and more
 * left no trace. Heartbeats and read-like POSTs are skipped; writes that
 * already log themselves in detail are tagged `auto` so both can be told apart.
 */

const SKIP = [
  /^\/api\/admin\/login$/,
  /^\/api\/admin\/session\/refresh$/,
  /^\/api\/admin\/moderation\/(lock|unlock)$/,
  /^\/api\/admin\/search$/,
  /^\/api\/admin\/export\//,
];
const SECRET = /pass(word)?|token|otp|secret|api[_-]?key|authorization/i;
const VERB = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

function redact(v, depth = 0) {
  if (v === null || v === undefined || depth > 4) return v;
  if (Array.isArray(v)) return v.length > 20 ? [...v.slice(0, 20).map((x) => redact(x, depth + 1)), `…+${v.length - 20} more`] : v.map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === '_audit') continue;
      out[k] = SECRET.test(k) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 300) return v.slice(0, 300) + `…(${v.length} chars)`;
  return v;
}

function actionOf(method, path) {
  const parts = path.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean);
  const ids = parts.filter((p) => /^\d+$/.test(p)).map(Number);
  const words = parts.filter((p) => !/^\d+$/.test(p));
  const last = parts[parts.length - 1] || '';
  const name = words.join('.') + (/^\d+$/.test(last) || words.length === 1 ? `.${VERB[method] || method.toLowerCase()}` : '');
  return { action: name.slice(0, 120), ids };
}

module.exports = (config, { strapi }) => async (ctx, next) => {
  await next();
  try {
    const method = ctx.method;
    if (!VERB[method]) return;
    const path = ctx.path || '';
    if (!path.startsWith('/api/admin')) return;
    if (SKIP.some((re) => re.test(path))) return;
    if ((ctx.status || 200) >= 400) return;
    const user = ctx.state && ctx.state.user;
    if (!user || !user.id) return;
    const { action, ids } = actionOf(method, path);
    let body = ctx.request.body;
    if (body && typeof body === 'object') body = redact(body);
    let bodyStr = '';
    try { bodyStr = JSON.stringify(body || null); } catch { bodyStr = '"[unserialisable]"'; }
    const details = {
      auto: true,
      method,
      path,
      ids,
      status: ctx.status,
      body: bodyStr.length > 2000 ? `${bodyStr.slice(0, 2000)}…` : body,
    };
    const targetUser = /^\/api\/admin\/users\/(\d+)/.exec(path);
    strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
      data: {
        adminUser: user.id,
        action: `auto:${action}`,
        targetUser: targetUser ? Number(targetUser[1]) : undefined,
        details,
        ipAddress: ctx.request.ip || null,
        userAgent: String(ctx.request.get('User-Agent') || '').slice(0, 300),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    }).catch((e) => strapi.log.warn(`[admin-audit-trail] ${e.message}`));
  } catch (e) {
    strapi.log.warn(`[admin-audit-trail] ${e.message}`);
  }
};
