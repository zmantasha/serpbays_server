/**
 * Marketplace Sync Service
 * 
 * Handles synchronization between publisher-website and marketplace tables.
 * 
 * SAFETY FEATURES:
 * - Dry-run mode (logs only, no database writes)
 * - Feature flags (enable/disable specific syncs)
 * - Comprehensive logging
 * - Error handling (never breaks main operations)
 * - Data validation
 */

const config = require('../../config/marketplace-sync');

module.exports = ({ strapi }) => ({
    /**
     * Sync complete website to marketplace
     * 
     * @param {number} websiteId - Publisher website ID
     * @param {string} operation - 'create' or 'update'
     * @returns {Object} Result with success status
     */
    async syncWebsite(websiteId, operation = 'update') {
        const startTime = Date.now();

        try {
            // Check if sync is enabled
            if (!config.enabled) {
                strapi.log.debug('[MARKETPLACE SYNC] Sync is globally disabled');
                return { success: false, reason: 'Sync disabled' };
            }

            // Fetch website
            const website = await strapi.entityService.findOne(
                'api::publisher-website.publisher-website',
                websiteId,
                { populate: ['currentPublisherId'] }
            );

            if (!website) {
                strapi.log.warn(`[MARKETPLACE SYNC] Website ${websiteId} not found`);
                return { success: false, reason: 'Website not found' };
            }

            // Only sync approved websites
            if (website.submissionStatus !== 'approved') {
                strapi.log.debug(`[MARKETPLACE SYNC] Website ${websiteId} not approved (status: ${website.submissionStatus})`);
                return { success: false, reason: 'Not approved' };
            }

            // Check if marketplace listing exists
            const existingMarketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
                where: { url: website.url }
            });

            // Build marketplace data
            const marketplaceData = this.buildMarketplaceData(website);

            // Validate data
            this.validateMarketplaceData(marketplaceData);

            // DRY RUN MODE
            if (config.dryRun) {
                const action = existingMarketplace ? 'UPDATE' : 'CREATE';
                strapi.log.info(`[MARKETPLACE SYNC - DRY RUN] Would ${action} marketplace listing`, {
                    websiteId,
                    url: website.url,
                    existingId: existingMarketplace?.id,
                    data: config.logging.logDiffs ? marketplaceData : 'hidden'
                });

                return {
                    success: true,
                    dryRun: true,
                    action,
                    data: marketplaceData
                };
            }

            // ACTUAL SYNC
            if (existingMarketplace) {
                // Update existing
                await strapi.db.query('api::marketplace.marketplace').update({
                    where: { id: existingMarketplace.id },
                    data: {
                        ...marketplaceData,
                        dataVersion: (existingMarketplace.dataVersion || 0) + 1,
                        updatedAt: new Date()
                    }
                });

                if (config.logging.logSuccess) {
                    strapi.log.info(`[MARKETPLACE SYNC] Updated marketplace listing`, {
                        websiteId,
                        url: website.url,
                        marketplaceId: existingMarketplace.id,
                        duration: Date.now() - startTime
                    });
                }
            } else {
                // Create new
                const newMarketplace = await strapi.entityService.create('api::marketplace.marketplace', {
                    data: {
                        ...marketplaceData,
                        dataVersion: 0,
                        createdAt: new Date()
                    }
                });

                if (config.logging.logSuccess) {
                    strapi.log.info(`[MARKETPLACE SYNC] Created marketplace listing`, {
                        websiteId,
                        url: website.url,
                        marketplaceId: newMarketplace.id,
                        duration: Date.now() - startTime
                    });
                }
            }

            return { success: true, dryRun: false };

        } catch (error) {
            strapi.log.error(`[MARKETPLACE SYNC ERROR] Website ${websiteId}:`, {
                error: error.message,
                stack: config.logging.level === 'debug' ? error.stack : undefined
            });

            return {
                success: false,
                error: error.message
            };
        }
    },

    /**
     * Sync only SEO metrics
     */
    async syncMetrics(websiteId) {
        try {
            if (!config.enabled || !config.features.syncMetrics) {
                return { success: false, reason: 'Metrics sync disabled' };
            }

            const website = await strapi.entityService.findOne(
                'api::publisher-website.publisher-website',
                websiteId,
                { fields: ['url', 'submissionStatus', ...Object.keys(config.fieldMapping.metrics)] }
            );

            if (!website || website.submissionStatus !== 'approved') {
                return { success: false, reason: 'Website not found or not approved' };
            }

            const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
                where: { url: website.url }
            });

            if (!marketplace) {
                strapi.log.debug(`[MARKETPLACE SYNC] No marketplace listing for ${website.url}`);
                return { success: false, reason: 'No marketplace listing' };
            }

            // Build metrics data
            const metricsData = {};
            for (const [sourceField, targetField] of Object.entries(config.fieldMapping.metrics)) {
                metricsData[targetField] = website[sourceField];
            }

            // DRY RUN
            if (config.dryRun) {
                strapi.log.info(`[MARKETPLACE SYNC - DRY RUN] Would update metrics`, {
                    websiteId,
                    url: website.url,
                    metrics: metricsData
                });
                return { success: true, dryRun: true };
            }

            // ACTUAL UPDATE
            await strapi.db.query('api::marketplace.marketplace').update({
                where: { id: marketplace.id },
                data: {
                    ...metricsData,
                    dataVersion: (marketplace.dataVersion || 0) + 1
                }
            });

            if (config.logging.logSuccess) {
                strapi.log.info(`[MARKETPLACE SYNC] Updated metrics for ${website.url}`);
            }

            return { success: true, dryRun: false };

        } catch (error) {
            strapi.log.error(`[MARKETPLACE SYNC ERROR] Metrics sync failed for ${websiteId}:`, error.message);
            return { success: false, error: error.message };
        }
    },

    /**
     * Sync only pricing
     */
    async syncPricing(websiteId) {
        try {
            if (!config.enabled || !config.features.syncPricing) {
                return { success: false, reason: 'Pricing sync disabled' };
            }

            const website = await strapi.entityService.findOne(
                'api::publisher-website.publisher-website',
                websiteId
            );

            if (!website || website.submissionStatus !== 'approved') {
                return { success: false, reason: 'Website not found or not approved' };
            }

            const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
                where: { url: website.url }
            });

            if (!marketplace) {
                return { success: false, reason: 'No marketplace listing' };
            }

            // Build pricing data (advertiser + publisher)
            const pricingData = {};

            // Advertiser prices (what customers pay)
            for (const [sourceField, targetField] of Object.entries(config.fieldMapping.pricing)) {
                pricingData[targetField] = website[sourceField] || 0;
            }

            // Publisher prices (calculated - 80% commission)
            pricingData.publisher_price = Math.floor(Math.max(
                (website.generalGuestPostPrice || 0) * config.publisherCommission,
                (website.generalLinkInsertionPrice || 0) * config.publisherCommission
            )) || 1;

            pricingData.publisher_link_insertion_price = Math.floor((website.generalLinkInsertionPrice || 0) * config.publisherCommission);
            pricingData.publisher_casino_pricing = Math.floor((website.casinoGuestPostPrice || 0) * config.publisherCommission);
            pricingData.publisher_crypto_pricing = Math.floor((website.cryptoGuestPostPrice || 0) * config.publisherCommission);
            pricingData.publisher_cbd_pricing = Math.floor((website.cbdGuestPostPrice || 0) * config.publisherCommission);
            pricingData.publisher_dating_pricing = Math.floor((website.datingGuestPostPrice || 0) * config.publisherCommission);

            // DRY RUN
            if (config.dryRun) {
                strapi.log.info(`[MARKETPLACE SYNC - DRY RUN] Would update pricing`, {
                    websiteId,
                    url: website.url,
                    pricing: pricingData
                });
                return { success: true, dryRun: true };
            }

            // ACTUAL UPDATE
            await strapi.db.query('api::marketplace.marketplace').update({
                where: { id: marketplace.id },
                data: {
                    ...pricingData,
                    dataVersion: (marketplace.dataVersion || 0) + 1
                }
            });

            if (config.logging.logSuccess) {
                strapi.log.info(`[MARKETPLACE SYNC] Updated pricing for ${website.url}`);
            }

            return { success: true, dryRun: false };

        } catch (error) {
            strapi.log.error(`[MARKETPLACE SYNC ERROR] Pricing sync failed for ${websiteId}:`, error.message);
            return { success: false, error: error.message };
        }
    },

    /**
     * Build complete marketplace data from publisher-website
     */
    buildMarketplaceData(website) {
        const data = {
            url: website.url,

            // SEO Metrics
            moz_da: website.moz_da,
            ahrefs_dr: website.ahrefs_dr,
            ahrefs_traffic: website.ahrefs_traffic,
            ahrefs_rank: website.ahrefs_rank,
            ahrefs_keywords: website.ahrefs_keywords,
            ahrefs_referring_domain: website.ahrefs_referring_domain,
            semrush_authority_score: website.semrush_authority_score,
            semrush_traffic: website.semrush_traffic,
            spam_score: website.moz_spam_score,

            // Pricing - Advertiser
            price: website.generalGuestPostPrice || 0,
            link_insertion_price: website.generalLinkInsertionPrice || 0,
            adv_casino_pricing: website.casinoGuestPostPrice || 0,
            adv_li_casino_pricing: website.casinoLinkInsertionPrice || 0,
            adv_crypto_pricing: website.cryptoGuestPostPrice || 0,
            adv_li_crypto_pricing: website.cryptoLinkInsertionPrice || 0,
            adv_cbd_pricing: website.cbdGuestPostPrice || 0,
            adv_li_cbd_pricing: website.cbdLinkInsertionPrice || 0,
            adv_dating_pricing: website.datingGuestPostPrice || 0,
            adv_li_dating_pricing: website.datingLinkInsertionPrice || 0,

            // Pricing - Publisher (80% commission)
            publisher_price: Math.floor(Math.max(
                (website.generalGuestPostPrice || 0) * config.publisherCommission,
                (website.generalLinkInsertionPrice || 0) * config.publisherCommission
            )) || 1,
            publisher_link_insertion_price: Math.floor((website.generalLinkInsertionPrice || 0) * config.publisherCommission),
            publisher_casino_pricing: Math.floor((website.casinoGuestPostPrice || 0) * config.publisherCommission),
            publisher_crypto_pricing: Math.floor((website.cryptoGuestPostPrice || 0) * config.publisherCommission),
            publisher_cbd_pricing: Math.floor((website.cbdGuestPostPrice || 0) * config.publisherCommission),
            publisher_dating_pricing: Math.floor((website.datingGuestPostPrice || 0) * config.publisherCommission),

            // Content
            description: website.description,
            category: website.categories,
            guidelines: website.guidelines,
            min_word_count: website.minWordCount || 500,

            // Technical
            backlink_type: website.backlinkType || 'Do follow',
            dofollow_link: website.allowedLinks || 1,
            backlink_validity: website.backlinkValidity,
            sponsored: website.sponsored || false,
            ugc: website.ugc || false,
            digital_pr: website.isPRSite || false,

            // Location
            countries: website.countries,
            language: website.languages,

            // Publisher
            // Use CURRENT email/name from user relation (always up-to-date), fallback to static fields for legacy records
            publisher_name: website.currentPublisherId?.username || website.publisherName,
            publisher_email: website.currentPublisherId?.email || website.publisherEmail,

            // GSC
            gsc_verified: website.gscVerified || false,
            gsc_verified_at: website.gscVerifiedAt,
            gsc_permission_level: website.gscPermissionLevel,
            gsc_refresh_token: website.gscRefreshToken,

            // Status
            status: config.statusMapping[website.submissionStatus] || 'active',
            approvalStatus: 'approved',
            website_status: 'active',
        };

        return data;
    },

    /**
     * Validate marketplace data before sync
     */
    validateMarketplaceData(data) {
        const errors = [];

        if (!data.url) {
            errors.push('Missing URL');
        }

        if (data.price < 0) {
            errors.push('Invalid price (negative)');
        }

        if (data.min_word_count < 0) {
            errors.push('Invalid word count (negative)');
        }

        if (errors.length > 0) {
            throw new Error(`Marketplace data validation failed: ${errors.join(', ')}`);
        }
    }
});
