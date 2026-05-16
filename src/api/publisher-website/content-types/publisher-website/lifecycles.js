const { getPublisherCommissionRate } = require('../../../../constants/commission');

const buildCategorySearchValue = (categoryValue) => {
  if (!categoryValue) {
    return '';
  }

  let values = [];
  if (Array.isArray(categoryValue)) {
    values = categoryValue;
  } else if (typeof categoryValue === 'string') {
    try {
      // If it's a JSON string, parse it; otherwise treat as comma separated string
      const parsed = JSON.parse(categoryValue);
      if (Array.isArray(parsed)) {
        values = parsed;
      } else {
        values = categoryValue.split(',').map((item) => item.trim());
      }
    } catch {
      values = categoryValue.split(',').map((item) => item.trim());
    }
  }

  const normalized = values
    .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
    .filter(Boolean);

  return normalized.length > 0 ? `|${normalized.join('|')}|` : '';
};

const sendModerationEmailIfNeeded = async (result) => {
  if (!result || result.submissionStatus !== 'approval_pending') return;
  if (!result.publisherEmail) return;
  try {
    const emailService = strapi.service('api::global.email-operations');
    await emailService.sendWebsiteStatusEmail({
      publisherEmail: result.publisherEmail,
      publisherName: result.publisherName || result.publisherEmail,
      websiteName: result.url,
      websiteUrl: result.url,
      actionType: 'Submitted for Moderation',
      is_added: true
    });
  } catch (emailError) {
    console.error('[EMAIL] Failed to send moderation email:', emailError.message);
  }
};

module.exports = {
  /**
   * After updating a website, handle marketplace creation/updates for approved websites
   */
  async afterUpdate(event) {
    const { result, params } = event;

    // Fire the "Submitted for Moderation" email when the publisher's Submit
    // for Review action transitions the status to approval_pending. Gating on
    // params.data ensures we only send when this update is the one that set
    // the status, not on every subsequent edit while it sits in that state.
    if (params?.data?.submissionStatus === 'approval_pending') {
      await sendModerationEmailIfNeeded(result);
    }

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
        // IMPORTANT: Fetch the full submission with populated currentPublisherId
        // The 'result' from event doesn't have relations populated
        const fullSubmission = await strapi.entityService.findOne('api::publisher-website.publisher-website', updatedWebsiteId, {
          populate: ['currentPublisherId']
        });

        if (!fullSubmission) {
          throw new Error('Website not found after update');
        }

        const controller = strapi.controller('api::publisher-website.publisher-website');
        if (controller && controller.createMarketplaceListing) {
          await controller.createMarketplaceListing(fullSubmission);
          console.log(`✅ Marketplace listing created for website ${updatedWebsiteId}`);
        } else {
          console.error('❌ createMarketplaceListing method not found');
        }
      } catch (marketplaceError) {
        console.error('❌ Failed to create marketplace listing:', marketplaceError.message);
        console.error('❌ Full error:', marketplaceError);

        // Revert approval status since marketplace creation failed
        try {
          await strapi.entityService.update('api::publisher-website.publisher-website', updatedWebsiteId, {
            data: {
              submissionStatus: 'verified_pending_review',
              reviewNotes: `Marketplace creation failed: ${marketplaceError.message}`
            }
          });
          console.log(`⏪ Reverted website ${updatedWebsiteId} to verified_pending_review due to marketplace error`);
        } catch (revertError) {
          console.error('❌ Failed to revert approval status:', revertError);
        }

        // Don't throw - return to prevent further processing
        return;
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

          // Send ownership transferred email to original publisher
          try {
            const emailService = strapi.service('api::global.email-operations');
            if (oldWebsite.publisherEmail) {
              await emailService.sendWebsiteStatusEmail({
                publisherEmail: oldWebsite.publisherEmail,
                publisherName: oldWebsite.publisherName || oldWebsite.publisherEmail,
                websiteName: oldWebsite.url,
                websiteUrl: oldWebsite.url,
                actionType: 'Transferred',
                notes: 'Ownership of this website has been transferred to a new owner.'
              });
            }
          } catch (emailError) {
            console.error('[EMAIL] Failed to send ownership transferred email:', emailError.message);
          }

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

      // CRITICAL: Ensure the NEWLY APPROVED website's marketplace entry is active
      // This is needed because the delisting above might have delisted the same entry
      // if the old and new websites share the same marketplaceId
      if (result.marketplaceId) {
        try {
          const currentMarketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { id: result.marketplaceId }
          });

          if (currentMarketplace && currentMarketplace.status !== 'active') {
            console.log(`🔄 Re-activating marketplace ${result.marketplaceId} for newly approved website ${result.url}`);
            await strapi.entityService.update('api::marketplace.marketplace', result.marketplaceId, {
              data: {
                status: 'active',
                delistedReason: null,
                delistedAt: null
              }
            });
            console.log(`✅ Marketplace ${result.marketplaceId} is now active for ${result.url}`);
          }
        } catch (reactivateError) {
          console.error(`⚠️ Failed to re-activate marketplace ${result.marketplaceId}:`, reactivateError);
        }
      }

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
            spam_score: result.moz_spam_score ?? null,
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

    // Auto-sync metrics and pricing to marketplace when an approved website's data changes.
    // Callers that already wrote to the marketplace directly set
    // _skipMarketplaceSync=true on their update payload. beforeUpdate moves
    // that flag into event.state because the data object is mutated before
    // afterUpdate sees it.
    if (event.state?.skipMarketplaceSync) {
      console.log('⏭️ publisher-website afterUpdate: marketplace sync skipped (caller-driven update)');
      return;
    }

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
        const COMMISSION_RATE = getPublisherCommissionRate();
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
            spam_score: dataUpdated.moz_spam_score ?? result.moz_spam_score ?? null,
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

            // Publisher earnings (80% of advertiser price) - return null if no base price set
            publisher_price: ((dataUpdated.generalGuestPostPrice ?? result.generalGuestPostPrice) > 0 ||
              (dataUpdated.generalLinkInsertionPrice ?? result.generalLinkInsertionPrice) > 0)
              ? Math.floor(Math.max(
                ((dataUpdated.generalGuestPostPrice ?? result.generalGuestPostPrice) || 0) * COMMISSION_RATE,
                ((dataUpdated.generalLinkInsertionPrice ?? result.generalLinkInsertionPrice) || 0) * COMMISSION_RATE
              )) || 1
              : null,
            publisher_link_insertion_price: (dataUpdated.generalLinkInsertionPrice ?? result.generalLinkInsertionPrice) > 0
              ? Math.floor((dataUpdated.generalLinkInsertionPrice ?? result.generalLinkInsertionPrice) * COMMISSION_RATE)
              : null,
            publisher_casino_pricing: ((dataUpdated.casinoGuestPostPrice ?? result.casinoGuestPostPrice) > 0 ||
              (dataUpdated.casinoLinkInsertionPrice ?? result.casinoLinkInsertionPrice) > 0)
              ? Math.floor(Math.max(
                ((dataUpdated.casinoGuestPostPrice ?? result.casinoGuestPostPrice) || 0) * COMMISSION_RATE,
                ((dataUpdated.casinoLinkInsertionPrice ?? result.casinoLinkInsertionPrice) || 0) * COMMISSION_RATE
              ))
              : null,
            publisher_crypto_pricing: ((dataUpdated.cryptoGuestPostPrice ?? result.cryptoGuestPostPrice) > 0 ||
              (dataUpdated.cryptoLinkInsertionPrice ?? result.cryptoLinkInsertionPrice) > 0)
              ? Math.floor(Math.max(
                ((dataUpdated.cryptoGuestPostPrice ?? result.cryptoGuestPostPrice) || 0) * COMMISSION_RATE,
                ((dataUpdated.cryptoLinkInsertionPrice ?? result.cryptoLinkInsertionPrice) || 0) * COMMISSION_RATE
              ))
              : null,
            publisher_cbd_pricing: ((dataUpdated.cbdGuestPostPrice ?? result.cbdGuestPostPrice) > 0 ||
              (dataUpdated.cbdLinkInsertionPrice ?? result.cbdLinkInsertionPrice) > 0)
              ? Math.floor(Math.max(
                ((dataUpdated.cbdGuestPostPrice ?? result.cbdGuestPostPrice) || 0) * COMMISSION_RATE,
                ((dataUpdated.cbdLinkInsertionPrice ?? result.cbdLinkInsertionPrice) || 0) * COMMISSION_RATE
              ))
              : null,
            publisher_dating_pricing: ((dataUpdated.datingGuestPostPrice ?? result.datingGuestPostPrice) > 0 ||
              (dataUpdated.datingLinkInsertionPrice ?? result.datingLinkInsertionPrice) > 0)
              ? Math.floor(Math.max(
                ((dataUpdated.datingGuestPostPrice ?? result.datingGuestPostPrice) || 0) * COMMISSION_RATE,
                ((dataUpdated.datingLinkInsertionPrice ?? result.datingLinkInsertionPrice) || 0) * COMMISSION_RATE
              ))
              : null,
            publisher_li_casino_pricing: (dataUpdated.casinoLinkInsertionPrice ?? result.casinoLinkInsertionPrice) > 0
              ? Math.floor((dataUpdated.casinoLinkInsertionPrice ?? result.casinoLinkInsertionPrice) * COMMISSION_RATE)
              : null,
            publisher_li_crypto_pricing: (dataUpdated.cryptoLinkInsertionPrice ?? result.cryptoLinkInsertionPrice) > 0
              ? Math.floor((dataUpdated.cryptoLinkInsertionPrice ?? result.cryptoLinkInsertionPrice) * COMMISSION_RATE)
              : null,
            publisher_li_cbd_pricing: (dataUpdated.cbdLinkInsertionPrice ?? result.cbdLinkInsertionPrice) > 0
              ? Math.floor((dataUpdated.cbdLinkInsertionPrice ?? result.cbdLinkInsertionPrice) * COMMISSION_RATE)
              : null,
            publisher_li_dating_pricing: (dataUpdated.datingLinkInsertionPrice ?? result.datingLinkInsertionPrice) > 0
              ? Math.floor((dataUpdated.datingLinkInsertionPrice ?? result.datingLinkInsertionPrice) * COMMISSION_RATE)
              : null,

            // Update timestamps
            metrics_last_updated: new Date(),
            metrics_update_method: 'lifecycle_auto'
          };

          // Drop price-group marketplace fields whose source publisher-website
          // fields weren't actually in this request. Without this, the
          // wholesale rebuild above defaults every untouched niche price to
          // null/0, generating spurious "— ↔ 0" rows in the marketplace
          // update history on every save.
          const dataKeys = new Set(Object.keys(dataUpdated));
          const PRICE_SYNC_GROUPS = [
            {
              triggers: ['generalGuestPostPrice', 'generalLinkInsertionPrice'],
              fields: ['price', 'link_insertion_price', 'publisher_price', 'publisher_link_insertion_price'],
            },
            {
              triggers: ['casinoGuestPostPrice', 'casinoLinkInsertionPrice'],
              fields: ['adv_casino_pricing', 'adv_li_casino_pricing', 'publisher_casino_pricing', 'publisher_li_casino_pricing'],
            },
            {
              triggers: ['cryptoGuestPostPrice', 'cryptoLinkInsertionPrice'],
              fields: ['adv_crypto_pricing', 'adv_li_crypto_pricing', 'publisher_crypto_pricing', 'publisher_li_crypto_pricing'],
            },
            {
              triggers: ['cbdGuestPostPrice', 'cbdLinkInsertionPrice'],
              fields: ['adv_cbd_pricing', 'adv_li_cbd_pricing', 'publisher_cbd_pricing', 'publisher_li_cbd_pricing'],
            },
            {
              triggers: ['datingGuestPostPrice', 'datingLinkInsertionPrice'],
              fields: ['adv_dating_pricing', 'adv_li_dating_pricing', 'publisher_dating_pricing', 'publisher_li_dating_pricing'],
            },
          ];
          for (const group of PRICE_SYNC_GROUPS) {
            const triggered = group.triggers.some((t) => dataKeys.has(t));
            if (!triggered) {
              for (const f of group.fields) delete updateDataMarketplace[f];
            }
          }

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

    // NEW: Professional sync service with feature flags and dry-run mode
    // This provides better architecture and can eventually replace the above sync code
    try {
      const config = require('../../../../../config/marketplace-sync');

      // Only run if new sync service is enabled
      if (config.enabled && result?.submissionStatus === 'approved') {
        const changedFields = Object.keys(params.data || {});

        if (changedFields.length > 0) {
          const metricsFields = ['moz_da', 'ahrefs_dr', 'ahrefs_traffic', 'ahrefs_rank',
            'semrush_authority_score', 'semrush_traffic', 'spam_score'];

          const pricingFields = ['generalGuestPostPrice', 'generalLinkInsertionPrice',
            'casinoGuestPostPrice', 'casinoLinkInsertionPrice', 'cryptoGuestPostPrice',
            'cryptoLinkInsertionPrice', 'cbdGuestPostPrice', 'cbdLinkInsertionPrice',
            'datingGuestPostPrice', 'datingLinkInsertionPrice'];

          const metricsChanged = config.features.syncMetrics &&
            metricsFields.some(f => changedFields.includes(f));

          const pricingChanged = config.features.syncPricing &&
            pricingFields.some(f => changedFields.includes(f));

          // Call new sync service (non-blocking, respects dry-run mode)
          if (metricsChanged || pricingChanged) {
            strapi.log.info(`[NEW SYNC SERVICE] Triggering sync for website ${result.id}`, {
              metricsChanged,
              pricingChanged,
              dryRun: config.dryRun
            });

            if (metricsChanged) {
              strapi.service('api::marketplace-sync.marketplace-sync')
                .syncMetrics(result.id)
                .catch(err => strapi.log.error('[NEW SYNC SERVICE ERROR]', err.message));
            }

            if (pricingChanged) {
              strapi.service('api::marketplace-sync.marketplace-sync')
                .syncPricing(result.id)
                .catch(err => strapi.log.error('[NEW SYNC SERVICE ERROR]', err.message));
            }
          }
        }
      }
    } catch (newSyncError) {
      // Silently ignore if new sync service not available yet
      if (newSyncError.message && !newSyncError.message.includes('Cannot find module')) {
        strapi.log.debug('[NEW SYNC SERVICE] Not available or disabled:', newSyncError.message);
      }
    }
  },

  /**
   * Before creating a website, log the action for debugging
   */
  async beforeCreate(event) {
    const { data } = event.params;
    console.log(`🆕 Creating new website entry for URL: ${data.url} by ${data.publisherEmail}`);

    const categorySearchValue = buildCategorySearchValue(data?.category);
    data.category_search = categorySearchValue;
  },

  /**
   * After creating a website, fire the moderation email if the row was
   * created directly in approval_pending (the ownership-claim flow does this).
   */
  async afterCreate(event) {
    await sendModerationEmailIfNeeded(event.result);
  },

  /**
   * Before updating a website, ensure derived search fields stay in sync
   */
  async beforeUpdate(event) {
    const { data } = event.params;
    if (data && Object.prototype.hasOwnProperty.call(data, 'category')) {
      data.category_search = buildCategorySearchValue(data.category);
    }
    // _skipMarketplaceSync is a transient signal for afterUpdate, not a real
    // column. Stash it on event.state so afterUpdate can read it, THEN strip
    // it from the persisted payload (Strapi would otherwise try to write it
    // as an unknown column).
    if (data && Object.prototype.hasOwnProperty.call(data, '_skipMarketplaceSync')) {
      event.state = event.state || {};
      event.state.skipMarketplaceSync = data._skipMarketplaceSync === true;
      delete data._skipMarketplaceSync;
    }
  }
};