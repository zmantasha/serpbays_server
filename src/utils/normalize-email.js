'use strict';

// Canonical email form. Trim + lowercase + collapse inner whitespace.
// Idempotent and safe on null/empty. Does NOT validate — caller's job.
function normalizeEmail(input) {
  if (input == null) return '';
  const s = String(input).trim().toLowerCase().replace(/\s+/g, '');
  return s;
}

module.exports = { normalizeEmail };
