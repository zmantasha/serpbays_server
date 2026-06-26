'use strict';

/**
 * Exchange Rate Service
 * Fetches real-time exchange rates from ExchangeRate-API
 */

// Cache for exchange rates
let cachedRates = null;
let lastFetchTime = null;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour cache

// API configuration
//
// Audit C10 fix — DO NOT hardcode the API key here. Previously this file
// had an env-var OR-fallback to a literal API key, leaking the key in
// source control (committed 2025-12-05; remains in git history — the
// provider-side key must be rotated to fully remediate). When the env var
// is unset at runtime, getExchangeRate() falls through to the
// FALLBACK_USD_TO_INR constant for INR — acceptable graceful degradation.
// The regression test scripts/test-secrets-not-hardcoded.js asserts no
// such fallback string is ever re-introduced.
const EXCHANGE_RATE_API_KEY = process.env.EXCHANGE_RATE_API_KEY || '';
const EXCHANGE_RATE_API_URL = EXCHANGE_RATE_API_KEY
  ? `https://v6.exchangerate-api.com/v6/${EXCHANGE_RATE_API_KEY}/latest/USD`
  : null;
const FALLBACK_USD_TO_INR = parseFloat(process.env.USD_TO_INR_RATE) || 83.25;
// The env-var override matches the documented fallback in .env.example
// (USD_TO_INR_RATE). Lets ops bump the static rate without a code deploy
// when EXCHANGE_RATE_API_KEY can't be granted (e.g. dev/staging).

// One-shot boot warning: log ONCE per process when the API key is unset,
// so ops sees the degraded path at startup instead of getting an
// error-level log on every fee calculation. Previously every Razorpay
// `calculate-fees` call hit console.error("API key not set") — flooding
// the log AND making ops chase a non-issue.
if (!EXCHANGE_RATE_API_URL) {
  console.warn(
    `[EXCHANGE RATE] EXCHANGE_RATE_API_KEY is not set. ` +
    `Falling back to static rate 1 USD = ${FALLBACK_USD_TO_INR} INR ` +
    `(override via USD_TO_INR_RATE env var). ` +
    `Razorpay flows will use this static rate until the key is provisioned.`
  );
}

module.exports = {
  /**
   * Get exchange rate for a specific currency pair
   * @param {string} from - Source currency (default: USD)
   * @param {string} to - Target currency (default: INR)
   * @returns {Promise<number>} Exchange rate
   */
  async getExchangeRate(from = 'USD', to = 'INR') {
    // Cache hit path — silent.
    const now = Date.now();
    if (cachedRates && lastFetchTime && (now - lastFetchTime) < CACHE_DURATION_MS) {
      const rate = cachedRates.conversion_rates?.[to];
      if (rate) return rate;
    }

    // No API key — return the static fallback directly. No throw, no
    // catch, no error log. The one-shot module-load warning above
    // already signaled the degraded path to ops.
    if (!EXCHANGE_RATE_API_URL) {
      if (to === 'INR') return FALLBACK_USD_TO_INR;
      // For any non-INR target we don't have a documented fallback —
      // surface as a thrown error (genuine misconfiguration).
      throw new Error(
        `Cannot resolve exchange rate to ${to}: EXCHANGE_RATE_API_KEY unset ` +
        `and no static fallback configured for this currency.`
      );
    }

    // Real API path. Any failure here IS an anomaly worth logging at
    // error level — network outage, rate-limit, API down, etc.
    try {
      console.log('[EXCHANGE RATE] Fetching fresh exchange rates from API...');
      const response = await fetch(EXCHANGE_RATE_API_URL, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Exchange rate API returned status ${response.status}`);
      }

      const data = await response.json();
      if (data.result !== 'success') {
        throw new Error(`Exchange rate API error: ${data['error-type'] || 'Unknown error'}`);
      }

      cachedRates = data;
      lastFetchTime = now;

      const rate = data.conversion_rates?.[to];
      if (!rate) {
        throw new Error(`Exchange rate for ${to} not found in API response`);
      }

      console.log(`[EXCHANGE RATE] Fresh rate fetched: 1 USD = ${rate} ${to}`);
      return rate;

    } catch (error) {
      // Real failure — log at error level so it triggers ops alerting.
      console.error('[EXCHANGE RATE] API request failed:', error.message);

      // Best-effort fallback for INR so payments keep working through
      // a transient API outage. The amount-mismatch defense (audit M11
      // in the realtime suite) catches any post-charge drift between
      // expected and actual INR amounts at webhook time, so a stale
      // fallback rate can't silently overcharge.
      if (to === 'INR') {
        console.warn(`[EXCHANGE RATE] Using fallback rate after API failure: 1 USD = ${FALLBACK_USD_TO_INR} INR`);
        return FALLBACK_USD_TO_INR;
      }
      throw error;
    }
  },

  /**
   * Convert amount from one currency to another
   * @param {number} amount - Amount to convert
   * @param {string} from - Source currency
   * @param {string} to - Target currency
   * @returns {Promise<{convertedAmount: number, rate: number}>}
   */
  async convert(amount, from = 'USD', to = 'INR') {
    const rate = await this.getExchangeRate(from, to);
    return {
      convertedAmount: amount * rate,
      rate
    };
  },

  /**
   * Clear the cached rates (useful for testing)
   */
  clearCache() {
    cachedRates = null;
    lastFetchTime = null;
    console.log('[EXCHANGE RATE] Cache cleared');
  },

  /**
   * Get cache info
   */
  getCacheInfo() {
    return {
      hasCachedRates: !!cachedRates,
      lastFetchTime: lastFetchTime ? new Date(lastFetchTime).toISOString() : null,
      cacheAge: lastFetchTime ? Date.now() - lastFetchTime : null,
      isExpired: lastFetchTime ? (Date.now() - lastFetchTime) >= CACHE_DURATION_MS : true
    };
  }
};

