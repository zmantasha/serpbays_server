module.exports = {
  /**
   * After updating a website, handle marketplace creation/updates for approved websites
   */
  async afterUpdate(event) {
    const { result, params } = event;
    
    // PREVENT INFINITE LOOP: Only process if status JUST changed to 'approved' AND no marketplaceId exists yet
    // This means it's a new approval, not an update to existing approved website
    const wasJustApproved = result.submissionStatus === 'approved' && !result.marketplaceId;
    
    if (wasJustApproved) {
      const updatedWebsiteUrl = result.url;
      const updatedWebsiteId = result.id;
      
      console.log(`🎉 Website ${updatedWebsiteId} (${updatedWebsiteUrl}) was approved for the first time.`);
      
      // STEP 1: Create marketplace listing for the newly approved website
      console.log(`📝 Creating marketplace listing for approved website ${updatedWebsiteId}`);
      try {
        const controller = strapi.controller('api::publisher-website.publisher-website');
        if (controller && controller.createMarketplaceListing) {
          await controller.createMarketplaceListing(result);
          console.log(`✅ Marketplace listing created for website ${updatedWebsiteId}`);
        } else {
          console.error('❌ createMarketplaceListing method not found');
        }
      } catch (marketplaceError) {
        console.error('❌ Failed to create marketplace listing:', marketplaceError);
      }
      
      // STEP 2: Find all other websites with the same URL that need ownership transfer
      // This includes both 'approved' and 'ownership_claimed' websites
      const otherWebsitesToTransfer = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        where: {
          url: updatedWebsiteUrl,
          submissionStatus: { $in: ['approved', 'ownership_claimed'] }, // Include both statuses
          id: { $ne: updatedWebsiteId } // Exclude the currently approved website
        }
        // Removed populate to avoid relation issues
      });
      
      if (otherWebsitesToTransfer.length > 0) {
        console.log(`🔄 Found ${otherWebsitesToTransfer.length} other websites (approved/ownership_claimed) with URL ${updatedWebsiteUrl}.`);
        
        for (const oldWebsite of otherWebsitesToTransfer) {
          console.log(`🔄 Transferring ownership for old website ${oldWebsite.id} (${oldWebsite.url}) - Status: ${oldWebsite.submissionStatus} → ownership_transferred`);
          
          // Update the old website to 'ownership_transferred'
          await strapi.entityService.update('api::publisher-website.publisher-website', oldWebsite.id, {
            data: {
              submissionStatus: 'ownership_transferred',
              ownershipTransferredAt: new Date().toISOString(),
              ownershipTransferReason: 'claimed_by_owner',
              newOwnerWebsiteId: updatedWebsiteId,
              // Keep other data intact for historical purposes
            }
          });
          console.log(`✅ Old website ${oldWebsite.id} status updated to 'ownership_transferred'.`);
          
          // Delist from marketplace if it had an entry
          if (oldWebsite.marketplaceId) {
            try {
              // Fetch the marketplace entry separately to avoid relation issues
              const marketplaceEntry = await strapi.db.query('api::marketplace.marketplace').findOne({
                where: { id: oldWebsite.marketplaceId }
              });
              
              if (marketplaceEntry) {
                await strapi.entityService.update('api::marketplace.marketplace', oldWebsite.marketplaceId, {
                  data: {
                    status: 'delisted',
                    delistedReason: 'ownership_transferred',
                    delistedAt: new Date().toISOString()
                  }
                });
                console.log(`📤 Marketplace listing ${oldWebsite.marketplaceId} delisted.`);
              }
            } catch (marketplaceError) {
              console.error(`⚠️ Failed to delist marketplace entry ${oldWebsite.marketplaceId}:`, marketplaceError);
              // Don't fail the whole operation if marketplace delisting fails
            }
          }
        }
      }
      
      console.log(`✅ Ownership transfer process completed for URL: ${updatedWebsiteUrl}`);

      // After first approval, ensure marketplace metrics are hydrated immediately
      try {
        const marketplaceList = await strapi.entityService.findMany('api::marketplace.marketplace', {
          filters: { url: updatedWebsiteUrl },
          limit: 1
        });

        if (Array.isArray(marketplaceList) && marketplaceList.length > 0) {
          const marketplaceId = marketplaceList[0].id;

          // Normalize placement_speed to allowed enum values
          const resolvePlacementSpeed = () => {
            const val = result.placement_speed;
            if (val === 'Ultra Fast' || val === 'Fast' || val === 'Normal' || val === 'Slow') return val;
            const tat = typeof result.expectedTATHours === 'number' ? result.expectedTATHours : null;
            if (tat != null) {
              if (tat <= 24) return 'Ultra Fast';
              if (tat <= 72) return 'Fast';
              if (tat <= 168) return 'Normal';
              return 'Slow';
            }
            return 'Normal';
          };

          const updateDataMarketplace = {
            ahrefs_dr: result.ahrefs_dr ?? null,
            ahrefs_traffic: result.ahrefs_traffic ?? null,
            ahrefs_rank: result.ahrefs_rank ?? null,
            moz_da: result.moz_da ?? null,
            moz_spam_score: result.moz_spam_score ?? null,
            semrush_traffic: result.semrush_traffic ?? null,
            semrush_authority_score: result.semrush_authority_score ?? null,
            ahrefs_referring_domain: result.ahrefs_referring_domain ?? null,
            ahrefs_keywords: result.ahrefs_keywords ?? null,
            placement_speed: resolvePlacementSpeed(),
            fast_placement_status: Boolean(result.fast_placement_status),
            metrics_last_updated: new Date(),
            metrics_update_method: 'lifecycle_approved_seed'
          };

          await strapi.entityService.update('api::marketplace.marketplace', marketplaceId, {
            data: updateDataMarketplace
          });

          console.log(`🧩 Seeded marketplace metrics for newly approved website ${updatedWebsiteId} (${updatedWebsiteUrl})`);
        }
      } catch (seedErr) {
        console.error('⚠️ Failed to seed marketplace metrics after approval:', seedErr);
      }
    }

    // Auto-sync metrics and pricing to marketplace when an approved website's data changes
    try {
      const metricsFields = [
        'ahrefs_dr',
        'ahrefs_traffic',
        'ahrefs_rank',
        'moz_da',
        'moz_spam_score',
        'semrush_traffic',
        'semrush_authority_score',
        'ahrefs_referring_domain',
        'ahrefs_keywords',
        'placement_speed',
        'fast_placement_status'
      ];

      const pricingFields = [
        'generalGuestPostPrice',
        'generalLinkInsertionPrice',
        'casinoGuestPostPrice',
        'casinoLinkInsertionPrice',
        'cryptoGuestPostPrice',
        'cryptoLinkInsertionPrice',
        'cbdGuestPostPrice',
        'cbdLinkInsertionPrice',
        'datingGuestPostPrice',
        'datingLinkInsertionPrice',
        'casinoAccepted',
        'cryptoAccepted',
        'cbdAccepted',
        'datingAccepted'
      ];

      const dataUpdated = params?.data || {};
      const anyMetricsChanged = metricsFields.some((f) => Object.prototype.hasOwnProperty.call(dataUpdated, f));
      const anyPricingChanged = pricingFields.some((f) => Object.prototype.hasOwnProperty.call(dataUpdated, f));

      if (result?.submissionStatus === 'approved' && (anyMetricsChanged || anyPricingChanged) && result?.url) {
        const marketplaceList = await strapi.entityService.findMany('api::marketplace.marketplace', {
          filters: { url: result.url },
          limit: 1
        });

        if (Array.isArray(marketplaceList) && marketplaceList.length > 0) {
          const marketplaceId = marketplaceList[0].id;

          // Normalize placement_speed to allowed enum values
          const normalizePlacementSpeed = (value, tat) => {
            if (value === 'Ultra Fast' || value === 'Fast' || value === 'Normal' || value === 'Slow') return value;
            const t = typeof tat === 'number' ? tat : null;
            if (t != null) {
              if (t <= 24) return 'Ultra Fast';
              if (t <= 72) return 'Fast';
              if (t <= 168) return 'Normal';
              return 'Slow';
            }
            return 'Normal';
          };

          const updateDataMarketplace = {
            // METRICS: Prefer freshly updated values from params.data falling back to result
            ahrefs_dr: dataUpdated.ahrefs_dr ?? result.ahrefs_dr ?? null,
            ahrefs_traffic: dataUpdated.ahrefs_traffic ?? result.ahrefs_traffic ?? null,
            ahrefs_rank: dataUpdated.ahrefs_rank ?? result.ahrefs_rank ?? null,
            moz_da: dataUpdated.moz_da ?? result.moz_da ?? null,
            moz_spam_score: dataUpdated.moz_spam_score ?? result.moz_spam_score ?? null,
            semrush_traffic: dataUpdated.semrush_traffic ?? result.semrush_traffic ?? null,
            semrush_authority_score: dataUpdated.semrush_authority_score ?? result.semrush_authority_score ?? null,
            ahrefs_referring_domain: dataUpdated.ahrefs_referring_domain ?? result.ahrefs_referring_domain ?? null,
            ahrefs_keywords: dataUpdated.ahrefs_keywords ?? result.ahrefs_keywords ?? null,
            placement_speed: normalizePlacementSpeed(
              dataUpdated.placement_speed ?? result.placement_speed,
              dataUpdated.expectedTATHours ?? result.expectedTATHours
            ),
            fast_placement_status: Boolean(dataUpdated.fast_placement_status ?? result.fast_placement_status),
            
            // PRICING: Sync pricing changes to marketplace
            // Advertiser pricing (what advertisers pay)
            price: dataUpdated.generalGuestPostPrice ?? result.generalGuestPostPrice ?? null,
            link_insertion_price: dataUpdated.generalLinkInsertionPrice ?? result.generalLinkInsertionPrice ?? null,
            adv_casino_pricing: dataUpdated.casinoGuestPostPrice ?? result.casinoGuestPostPrice ?? null,
            adv_li_casino_pricing: dataUpdated.casinoLinkInsertionPrice ?? result.casinoLinkInsertionPrice ?? null,
            adv_crypto_pricing: dataUpdated.cryptoGuestPostPrice ?? result.cryptoGuestPostPrice ?? null,
            adv_li_crypto_pricing: dataUpdated.cryptoLinkInsertionPrice ?? result.cryptoLinkInsertionPrice ?? null,
            adv_cbd_pricing: dataUpdated.cbdGuestPostPrice ?? result.cbdGuestPostPrice ?? null,
            adv_li_cbd_pricing: dataUpdated.cbdLinkInsertionPrice ?? result.cbdLinkInsertionPrice ?? null,
            adv_dating_pricing: dataUpdated.datingGuestPostPrice ?? result.datingGuestPostPrice ?? null,
            adv_li_dating_pricing: dataUpdated.datingLinkInsertionPrice ?? result.datingLinkInsertionPrice ?? null,
            
            // Publisher earnings (80% of advertiser price)
            publisher_price: Math.floor(Math.max(
              (dataUpdated.generalGuestPostPrice ?? result.generalGuestPostPrice ?? 0) * 0.8,
              (dataUpdated.generalLinkInsertionPrice ?? result.generalLinkInsertionPrice ?? 0) * 0.8
            )) || 1,
            publisher_link_insertion_price: Math.floor((dataUpdated.generalLinkInsertionPrice ?? result.generalLinkInsertionPrice ?? 0) * 0.8),
            publisher_casino_pricing: Math.floor(Math.max(
              (dataUpdated.casinoGuestPostPrice ?? result.casinoGuestPostPrice ?? 0) * 0.8,
              (dataUpdated.casinoLinkInsertionPrice ?? result.casinoLinkInsertionPrice ?? 0) * 0.8
            )),
            publisher_crypto_pricing: Math.floor(Math.max(
              (dataUpdated.cryptoGuestPostPrice ?? result.cryptoGuestPostPrice ?? 0) * 0.8,
              (dataUpdated.cryptoLinkInsertionPrice ?? result.cryptoLinkInsertionPrice ?? 0) * 0.8
            )),
            publisher_cbd_pricing: Math.floor(Math.max(
              (dataUpdated.cbdGuestPostPrice ?? result.cbdGuestPostPrice ?? 0) * 0.8,
              (dataUpdated.cbdLinkInsertionPrice ?? result.cbdLinkInsertionPrice ?? 0) * 0.8
            )),
            publisher_dating_pricing: Math.floor(Math.max(
              (dataUpdated.datingGuestPostPrice ?? result.datingGuestPostPrice ?? 0) * 0.8,
              (dataUpdated.datingLinkInsertionPrice ?? result.datingLinkInsertionPrice ?? 0) * 0.8
            )),
            publisher_li_casino_pricing: Math.floor((dataUpdated.casinoLinkInsertionPrice ?? result.casinoLinkInsertionPrice ?? 0) * 0.8),
            publisher_li_crypto_pricing: Math.floor((dataUpdated.cryptoLinkInsertionPrice ?? result.cryptoLinkInsertionPrice ?? 0) * 0.8),
            publisher_li_cbd_pricing: Math.floor((dataUpdated.cbdLinkInsertionPrice ?? result.cbdLinkInsertionPrice ?? 0) * 0.8),
            publisher_li_dating_pricing: Math.floor((dataUpdated.datingLinkInsertionPrice ?? result.datingLinkInsertionPrice ?? 0) * 0.8),
            
            // Update timestamps
            metrics_last_updated: new Date(),
            metrics_update_method: 'lifecycle_auto'
          };

          await strapi.entityService.update('api::marketplace.marketplace', marketplaceId, {
            data: updateDataMarketplace
          });

          console.log(`🔁 Synced metrics and pricing to marketplace (${marketplaceId}) for approved website ${result.id} (${result.url})`);
        } else {
          console.log(`ℹ️ No marketplace entry found to sync metrics for ${result.url}`);
        }
      }
    } catch (syncError) {
      console.error('⚠️ Metrics and pricing sync to marketplace failed in lifecycle afterUpdate:', syncError);
      // Non-blocking: do not throw to avoid interrupting the original update
    }
  },

  /**
   * Before creating a website, log the action for debugging
   */
  async beforeCreate(event) {
    const { data } = event.params;
    console.log(`🆕 Creating new website entry for URL: ${data.url} by ${data.publisherEmail}`);
  }
};