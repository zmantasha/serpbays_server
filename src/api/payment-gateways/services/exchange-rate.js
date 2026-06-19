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
const FALLBACK_USD_TO_INR = 83.25; // Fallback rate if API fails or key unset

module.exports = {
  /**
   * Get exchange rate for a specific currency pair
   * @param {string} from - Source currency (default: USD)
   * @param {string} to - Target currency (default: INR)
   * @returns {Promise<number>} Exchange rate
   */
  async getExchangeRate(from = 'USD', to = 'INR') {
    try {
      // Check if we have cached rates that are still valid
      const now = Date.now();
      if (cachedRates && lastFetchTime && (now - lastFetchTime) < CACHE_DURATION_MS) {
        console.log('[EXCHANGE RATE] Using cached exchange rate');
        const rate = cachedRates.conversion_rates?.[to];
        if (rate) {
          return rate;
        }
      }

      // Audit C10 fix — when no API key is configured, skip the network
      // call entirely and let the catch-and-fallback path handle it.
      // Previously a hardcoded key was used as a fallback; that key is
      // now rotated and removed from source.
      if (!EXCHANGE_RATE_API_URL) {
        throw new Error('EXCHANGE_RATE_API_KEY env var is not set');
      }

      // Fetch fresh rates from API
      console.log('[EXCHANGE RATE] Fetching fresh exchange rates from API...');
      const response = await fetch(EXCHANGE_RATE_API_URL, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Exchange rate API returned status ${response.status}`);
      }

      const data = await response.json();

      if (data.result !== 'success') {
        throw new Error(`Exchange rate API error: ${data['error-type'] || 'Unknown error'}`);
      }

      // Cache the rates
      cachedRates = data;
      lastFetchTime = now;

      const rate = data.conversion_rates?.[to];
      if (!rate) {
        throw new Error(`Exchange rate for ${to} not found in API response`);
      }

      console.log(`[EXCHANGE RATE] Fresh rate fetched: 1 USD = ${rate} ${to}`);
      return rate;

    } catch (error) {
      console.error('[EXCHANGE RATE] Error fetching exchange rate:', error.message);
      
      // Return fallback rate
      if (to === 'INR') {
        console.log(`[EXCHANGE RATE] Using fallback rate: 1 USD = ${FALLBACK_USD_TO_INR} INR`);
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

