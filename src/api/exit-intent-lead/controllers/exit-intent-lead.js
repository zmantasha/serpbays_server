'use strict';

/**
 * exit-intent-lead controller.
 *
 * SECURITY — create override.
 *
 * The default core router + the Public role's
 * `api::exit-intent-lead.exit-intent-lead.create` grant make
 * POST /api/exit-intent-leads anonymously reachable (intentional —
 * the exit-intent popup on the marketing site needs an unauthenticated
 * submission path). The pre-fix controller was the bare default
 * `createCoreController` with no overrides. The default Strapi core
 * create handler accepts EVERY column in `data`, so an anonymous caller
 * could mass-assign:
 *   - status: 'qualified' / 'won' (lie about pipeline state)
 *   - internalNotes: '<arbitrary>' (sales-team-visible field; XSS vector
 *     if the admin panel renders unescaped)
 *   - clerkUserId / userName / userEmail (the schema comment explicitly
 *     says these are "server-detected, not client-trusted" — yet the
 *     default controller trusts them)
 *
 * Fix: explicit field allow-list. Caller may only set lead-supplied fields.
 * Server-side identity fields (clerkUserId / userName / userEmail) are
 * populated from `ctx.state.user` only when a session is present.
 * Admin-controlled fields (status, internalNotes) are NEVER accepted from
 * the request body — set by lifecycles + sales workflow.
 *
 * NOTE (ops): this endpoint is anonymously reachable and triggers an
 * outbound notification email (via afterCreate lifecycle). Recommend a
 * per-IP rate limit middleware (e.g. 5 submissions / 10min / IP) to defeat
 * inbox-flooding attacks on the sales team's mailboxes. Not enforced here.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const VALID_ROLES = ['buyer', 'seller'];

const LIMITS = {
  name: 200,
  countryCode: 8,
  whatsapp: 32,
  email: 254,
  requirements: 4000,
  websiteUrl: 500,
  details: 4000,
  path: 500,
  referrer: 1000,
  userAgent: 2000,
};

function clipStr(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

module.exports = createCoreController('api::exit-intent-lead.exit-intent-lead', ({ strapi }) => ({
  async create(ctx) {
    try {
      const body = ctx.request.body?.data || ctx.request.body || {};

      // Role + minimum-viable input.
      if (!body.role || !VALID_ROLES.includes(body.role)) {
        return ctx.badRequest('role must be one of: buyer, seller');
      }
      const name = clipStr(body.name, LIMITS.name);
      const email = clipStr(body.email, LIMITS.email);
      if (!name) return ctx.badRequest('name is required');
      if (!email || !email.includes('@') || email.length < 6) {
        return ctx.badRequest('email is required and must be a valid email');
      }

      // Build the sanitised payload from the allow-list only.
      const payload = { role: body.role, name, email };
      const optionalStrings = ['countryCode', 'whatsapp', 'requirements', 'websiteUrl', 'details', 'path', 'referrer', 'userAgent'];
      for (const f of optionalStrings) {
        const v = clipStr(body[f], LIMITS[f]);
        if (v !== undefined) payload[f] = v;
      }
      if (body.timeOnSiteSec !== undefined) {
        const n = Number.parseInt(body.timeOnSiteSec, 10);
        if (Number.isFinite(n) && n >= 0 && n <= 86_400 * 7) {
          payload.timeOnSiteSec = n;
        }
      }

      // Server-detected identity — NEVER taken from request body.
      const sessionUser = ctx.state?.user;
      if (sessionUser) {
        if (sessionUser.clerkId) payload.clerkUserId = sessionUser.clerkId;
        if (sessionUser.username) payload.userName = sessionUser.username;
        if (sessionUser.email) payload.userEmail = sessionUser.email;
      }

      // `status` and `internalNotes` are NEVER accepted from the body.
      // status defaults via the schema (= 'new'); the beforeCreate
      // lifecycle may downgrade duplicates to 'spam'.

      const entity = await strapi.entityService.create('api::exit-intent-lead.exit-intent-lead', {
        data: payload,
      });

      // Return a minimal acknowledgement — no internal fields leak.
      return ctx.send({
        data: { id: entity.id, role: entity.role },
      });
    } catch (error) {
      strapi.log?.error?.('[exit-intent-lead] create failed', { error: error.message });
      return ctx.internalServerError('Failed to record lead');
    }
  },
}));
