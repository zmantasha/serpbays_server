'use strict';

// Canonical URL form used for marketplace dedup. Idempotent and safe on null/empty.
// Keep this in sync with the partial UNIQUE INDEX expression on marketplaces.url.
function normalizeUrl(input) {
  if (input == null) return '';
  let s = String(input).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  // Drop path / query / fragment — keep host only.
  s = s.split('/')[0].split('?')[0].split('#')[0];
  // Drop port (no IPv6 in this dataset).
  s = s.split(':')[0];
  // Strip trailing FQDN dot.
  s = s.replace(/\.$/, '');
  return s;
}

module.exports = { normalizeUrl };
