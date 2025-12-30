/**
 * Marketplace Sync Configuration
 * 
 * Controls synchronization between publisher-website and marketplace tables.
 * All sync operations respect these settings for safety and control.
 * 
 * @module config/marketplace-sync
 * @requires process.env
 * 
 * Environment Variables:
 * - MARKETPLACE_SYNC_ENABLED: Master switch (default: false)
 * - MARKETPLACE_SYNC_DRY_RUN: Safe mode - logs only (default: true)
 * - SYNC_METRICS: Enable SEO metrics sync (default: false)
 * - SYNC_PRICING: Enable pricing sync (default: false)
 * - SYNC_CONTENT: Enable content sync (default: false)
 * - SYNC_ON_APPROVAL: Create listing on approval (default: false)
 * 
 * @example
 * // Enable metrics sync in .env
 * MARKETPLACE_SYNC_ENABLED=true
 * SYNC_METRICS=true
 */

// Constants
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_DELAY_MS = 100;
const DEFAULT_TIMEOUT_MS = 5000;
const PUBLISHER_COMMISSION_RATE = 0.8; // 80% of advertiser price

module.exports = {
    // ==========================================
    // MARKETPLACE SYNC CONFIGURATION
    // ==========================================

    // MASTER SWITCH - Set to false to disable ALL sync operations
    enabled: process.env.MARKETPLACE_SYNC_ENABLED === 'true' || false,

    // SAFETY MODE - When true, logs operations but doesn't write to database
    dryRun: process.env.MARKETPLACE_SYNC_DRY_RUN !== 'false', // Default: true (safe)

    // FEATURE FLAGS - Enable/disable specific sync operations
    features: {
        // Sync SEO metrics (DA, DR, traffic, etc.)
        syncMetrics: process.env.SYNC_METRICS === 'true' || false,

        // Sync pricing fields
        syncPricing: process.env.SYNC_PRICING === 'true' || false,

        // Sync content (description, guidelines, etc.)
        syncContent: process.env.SYNC_CONTENT === 'true' || false,

        // Create marketplace listing on approval
        syncOnApproval: process.env.SYNC_ON_APPROVAL === 'true' || false,

        // Delete marketplace listing on rejection
        deleteOnReject: process.env.DELETE_ON_REJECT === 'true' || false,
    },

    // PERFORMANCE SETTINGS
    performance: {
        // Number of websites to sync in parallel
        batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '10'),

        // Delay between batches (ms)
        delayMs: parseInt(process.env.SYNC_DELAY_MS || '100'),

        // Timeout for single sync operation (ms)
        timeoutMs: parseInt(process.env.SYNC_TIMEOUT_MS || '5000'),
    },

    // LOGGING
    logging: {
        // Log level: 'debug', 'info', 'warn', 'error'
        level: process.env.SYNC_LOG_LEVEL || 'info',

        // Log successful syncs
        logSuccess: process.env.SYNC_LOG_SUCCESS !== 'false',

        // Log data diffs (before/after)
        logDiffs: process.env.SYNC_LOG_DIFFS === 'true' || false,
    },

    // FIELD MAPPING - Publisher-website → Marketplace
    fieldMapping: {
        // SEO Metrics
        metrics: {
            moz_da: 'moz_da',
            ahrefs_dr: 'ahrefs_dr',
            ahrefs_traffic: 'ahrefs_traffic',
            ahrefs_rank: 'ahrefs_rank',
            ahrefs_keywords: 'ahrefs_keywords',
            ahrefs_referring_domain: 'ahrefs_referring_domain',
            semrush_authority_score: 'semrush_authority_score',
            semrush_traffic: 'semrush_traffic',
            moz_spam_score: 'spam_score',
        },

        // Pricing (Advertiser)
        pricing: {
            generalGuestPostPrice: 'price',
            generalLinkInsertionPrice: 'link_insertion_price',
            casinoGuestPostPrice: 'adv_casino_pricing',
            casinoLinkInsertionPrice: 'adv_li_casino_pricing',
            cryptoGuestPostPrice: 'adv_crypto_pricing',
            cryptoLinkInsertionPrice: 'adv_li_crypto_pricing',
            cbdGuestPostPrice: 'adv_cbd_pricing',
            cbdLinkInsertionPrice: 'adv_li_cbd_pricing',
            datingGuestPostPrice: 'adv_dating_pricing',
            datingLinkInsertionPrice: 'adv_li_dating_pricing',
        },

        // Content
        content: {
            description: 'description',
            categories: 'category',
            guidelines: 'guidelines',
            minWordCount: 'min_word_count',
        },

        // Technical
        technical: {
            backlinkType: 'backlink_type',
            allowedLinks: 'dofollow_link',
            backlinkValidity: 'backlink_validity',
            sponsored: 'sponsored',
            ugc: 'ugc',
            isPRSite: 'digital_pr',
        },
    },

    // STATUS MAPPING
    statusMapping: {
        'approved': 'active',
        'listing_paused': 'paused',
        'rejected': 'delisted',
    },

    // PUBLISHER COMMISSION (what publisher earns)
    publisherCommission: 0.8, // 80% of advertiser price
};
