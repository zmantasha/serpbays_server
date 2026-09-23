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


/**
 * Platform fee rate — the cut taken when a PUBLISHER WITHDRAWS funds.
 *
 * The publisher is credited the full advertiser price at order completion;
 * the platform's margin is realised here instead. To receive `net`, the
 * publisher is deducted:
 *
 *   platformFee    = (net / (1 - PLATFORM_FEE_RATE)) * PLATFORM_FEE_RATE
 *   totalDeduction = net + platformFee
 *
 * i.e. the fee is 20% of the GROSS deduction, which is why it reconciles
 * with publisher_price = price x 0.8 on the listing side.
 *
 * Read from the PLATFORM_FEE_RATE env var. Clamped to [0, 1).
 * Default 0.20 — the historical hardcoded value, so behaviour is unchanged
 * if the env var is absent. Must be < 1 (a rate of 1 divides by zero above).
 */
function getPlatformFeeRate() {
  const raw = parseFloat(process.env.PLATFORM_FEE_RATE);
  if (!Number.isFinite(raw)) return 0.20;
  if (raw < 0) return 0;
  if (raw >= 1) return 0.99;
  return raw;
}

module.exports = {
  getPublisherCommissionRate,
  getPlatformFeeRate,
};
