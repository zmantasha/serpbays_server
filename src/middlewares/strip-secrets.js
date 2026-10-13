'use strict';

/**
 * Strip user secrets from every /api/admin response (2026-10-13).
 *
 * Several admin controllers populate whole user rows (`populate:
 * ['publisher']`, or `fields` inside a db.query populate, which db.query
 * ignores). Those rows carry private schema attributes: password hash,
 * reset/confirmation tokens and the withdrawal OTP. This middleware removes
 * them at any depth before the response leaves, so a new endpoint can't
 * reintroduce the leak. It only deletes these keys; nothing else changes.
 */

const SECRET_KEYS = new Set([
  'password',
  'resetPasswordToken',
  'confirmationToken',
  'withdrawalOtp',
  'withdrawalOtpExpiry',
  'withdrawalOtpSentAt',
  'withdrawalOtpAmount',
  'withdrawalOtpAttempts',
]);

function scrub(node, depth) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) scrub(item, depth + 1);
    return;
  }
  for (const key of Object.keys(node)) {
    if (SECRET_KEYS.has(key)) delete node[key];
    else {
      const v = node[key];
      if (v && typeof v === 'object' && !(v instanceof Date)) scrub(v, depth + 1);
    }
  }
}

module.exports = () => async (ctx, next) => {
  await next();
  if (!ctx.path || !ctx.path.startsWith('/api/admin')) return;
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Buffer.isBuffer(body) || typeof body.pipe === 'function') return;
  scrub(body, 0);
};
