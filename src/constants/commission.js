'use strict';

/**
 * Publisher commission rate — the share of the advertiser-facing price
 * that the publisher actually receives.
 *
 *   publisher_price = price × PUBLISHER_COMMISSION_RATE
 *
 * Read from the PUBLISHER_COMMISSION_RATE env var. Clamped to [0, 1].
 * Default is 1.0 (publisher gets 100% — the platform monetises elsewhere).
 * Set to e.g. 0.8 to take a 20% platform cut from the publisher side.
 *
 * Every call goes through getPublisherCommissionRate() rather than reading
 * the env var directly so the value can change between requests during
 * development without restarting the server.
 */
function getPublisherCommissionRate() {
  const raw = parseFloat(process.env.PUBLISHER_COMMISSION_RATE);
  if (!Number.isFinite(raw)) return 1.0;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

module.exports = {
  getPublisherCommissionRate,
};
