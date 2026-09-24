'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const { getPublisherCommissionRate } = require('../../../constants/commission');

module.exports = createCoreController('api::website-update-request.website-update-request', ({ strapi }) => ({
  async findPending(ctx) {
    try {
      const pendingRequests = await strapi.entityService.findMany('api::website-update-request.website-update-request', {
        filters: { status: 'pending' },
        populate: {
          marketplace: true,
          publisherWebsite: true,
        },
        sort: { createdAt: 'desc' }
      });

      return { data: pendingRequests };
    } catch (error) {
      strapi.log.error('[WEBSITE UPDATE REQUEST] Failed to fetch pending requests', error);
      return ctx.internalServerError('Failed to load pending update requests');
    }
  },

  async approve(ctx) {
    try {
      const { id } = ctx.params;
      const adminUser = ctx.state.user;
      if (!adminUser) {
        return ctx.unauthorized('Authentication required');
      }

      const request = await strapi.entityService.findOne('api::website-update-request.website-update-request', id, {
        populate: ['marketplace', 'publisherWebsite']
      });

      if (!request) {
        return ctx.notFound('Update request not found');
      }

      if (request.status !== 'pending') {
        return ctx.badRequest('Only pending requests can be approved');
      }

      let marketplaceId = request.marketplace?.id;
      let marketplaceListing = null;

      // Try to find marketplace by ID first
      if (marketplaceId) {
        marketplaceListing = await strapi.db.query('api::marketplace.marketplace').findOne({
          where: { id: marketplaceId }
        });
      }

      // Fallback: If not found by ID, try to find by URL from publisher website
      if (!marketplaceListing && request.publisherWebsite?.url) {
        strapi.log.warn('[WEBSITE UPDATE REQUEST] Marketplace not found by ID, trying URL lookup:', {
          marketplaceId,
          url: request.publisherWebsite.url
        });
        
        marketplaceListing = await strapi.db.query('api::marketplace.marketplace').findOne({
          where: { url: request.publisherWebsite.url }
        });
        
        if (marketplaceListing) {
          marketplaceId = marketplaceListing.id;
          strapi.log.info('[WEBSITE UPDATE REQUEST] Found marketplace by URL:', {
            url: request.publisherWebsite.url,
            marketplaceId: marketplaceListing.id
          });
        }
      }

      if (!marketplaceListing) {
        strapi.log.error('[WEBSITE UPDATE REQUEST] Marketplace listing not found:', {
          marketplaceId: request.marketplace?.id,
          publisherWebsiteUrl: request.publisherWebsite?.url,
          publisherWebsiteId: request.publisherWebsite?.id
        });
        return ctx.badRequest('Marketplace listing not found. Please ensure the website has been approved and added to marketplace.');
      }

      console.log('[WEBSITE UPDATE REQUEST] Found marketplace listing:', {
        id: marketplaceListing.id,
        url: marketplaceListing.url,
        currentPrice: marketplaceListing.price,
        currentLinkInsertionPrice: marketplaceListing.link_insertion_price,
        publishedAt: marketplaceListing.publishedAt,
        approvalStatus: marketplaceListing.approvalStatus
      });

      const changes = request.changes || {};
      if (Object.keys(changes).length === 0) {
        await strapi.entityService.update('api::website-update-request.website-update-request', id, {
          data: {
            status: 'superseded',
            reviewedBy: adminUser.email || adminUser.username || 'admin',
            reviewedAt: new Date(),
            notes: 'No changes to apply'
          }
        });

        return ctx.send({ message: 'Request closed. No changes to apply.' });
      }

      // Prepare apply data with proper type coercion
      const applyData = {};
      const COMMISSION_RATE = getPublisherCommissionRate();
      const computeShare = (value) => {
        const num = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(num) || num < 0) return null;
        return Math.floor(num * COMMISSION_RATE);
      };

      // Coerce all numeric fields properly
      Object.entries(changes).forEach(([key, value]) => {
        // Handle numeric fields
        const numericFields = [
          'price', 'link_insertion_price', 'adv_casino_pricing', 'adv_li_casino_pricing',
          'adv_crypto_pricing', 'adv_li_crypto_pricing', 'adv_cbd_pricing', 'adv_li_cbd_pricing',
          'adv_dating_pricing', 'adv_li_dating_pricing', 'min_word_count', 'publisher_writing_price', 'tat'
        ];
        
        if (numericFields.includes(key)) {
          const num = typeof value === 'number' ? value : Number(value);
          applyData[key] = Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
        } else if (key === 'placement_speed') {
          // Enum field - keep as is
          applyData[key] = value;
        } else if (Array.isArray(value)) {
          // Array fields
          applyData[key] = value;
        } else if (typeof value === 'boolean') {
          // Boolean fields
          applyData[key] = value;
        } else {
          // String and other fields
          applyData[key] = value;
        }
      });

      // Compute publisher earnings (80% of advertiser prices)
      if (Object.prototype.hasOwnProperty.call(applyData, 'price')) {
        const share = computeShare(applyData.price);
        if (share !== null) {
          applyData.publisher_price = Math.max(share, 1);
        }
      }

      if (Object.prototype.hasOwnProperty.call(applyData, 'link_insertion_price')) {
        const share = computeShare(applyData.link_insertion_price);
        if (share !== null) {
          applyData.publisher_link_insertion_price = share;
        }
      }

      const sensitivePairs = [
        { advField: 'adv_casino_pricing', publisherField: 'publisher_casino_pricing', shareField: 'publisher_li_casino_pricing', liField: 'adv_li_casino_pricing' },
        { advField: 'adv_crypto_pricing', publisherField: 'publisher_crypto_pricing', shareField: 'publisher_li_crypto_pricing', liField: 'adv_li_crypto_pricing' },
        { advField: 'adv_cbd_pricing', publisherField: 'publisher_cbd_pricing', shareField: 'publisher_li_cbd_pricing', liField: 'adv_li_cbd_pricing' },
        { advField: 'adv_dating_pricing', publisherField: 'publisher_dating_pricing', shareField: 'publisher_li_dating_pricing', liField: 'adv_li_dating_pricing' }
      ];

      sensitivePairs.forEach(({ advField, publisherField, shareField, liField }) => {
        if (Object.prototype.hasOwnProperty.call(applyData, advField)) {
          const share = computeShare(applyData[advField]);
          if (share !== null) {
            applyData[publisherField] = share;
          }
        }
        if (liField && Object.prototype.hasOwnProperty.call(applyData, liField)) {
          const share = computeShare(applyData[liField]);
          if (share !== null) {
            applyData[shareField] = share;
          }
        }
      });

      applyData.dataVersion = (marketplaceListing.dataVersion || 0) + 1;

      // Ensure listing visibility - always set publishedAt and approvalStatus when approving
      if (!marketplaceListing.publishedAt) {
        applyData.publishedAt = new Date();
        applyData.approvalStatus = 'approved';
      }

      // Apply changes to the marketplace listing
      console.log('[WEBSITE UPDATE REQUEST] Applying changes to marketplace:', {
        marketplaceId,
        changesCount: Object.keys(applyData).length,
        keyChanges: Object.keys(applyData).filter(k => k !== 'dataVersion' && k !== 'publishedAt' && k !== 'approvalStatus'),
        priceChange: applyData.price !== undefined ? `${marketplaceListing.price} -> ${applyData.price}` : 'no change',
        linkInsertionChange: applyData.link_insertion_price !== undefined ? `${marketplaceListing.link_insertion_price} -> ${applyData.link_insertion_price}` : 'no change',
        publishedAt: applyData.publishedAt ? 'will be set' : 'already set'
      });

      // Use database query API for more reliable updates
      const updatedMarketplace = await strapi.db.query('api::marketplace.marketplace').update({
        where: { id: marketplaceId },
        data: applyData
      });

      if (!updatedMarketplace) {
        strapi.log.error('[WEBSITE UPDATE REQUEST] Failed to update marketplace - update returned null');
        return ctx.internalServerError('Failed to update marketplace listing');
      }

      console.log('[WEBSITE UPDATE REQUEST] Marketplace updated successfully (DB query):', {
        id: updatedMarketplace.id,
        url: updatedMarketplace.url,
        publishedAt: updatedMarketplace.publishedAt,
        approvalStatus: updatedMarketplace.approvalStatus,
        price: updatedMarketplace.price,
        link_insertion_price: updatedMarketplace.link_insertion_price,
        updatedAt: updatedMarketplace.updatedAt
      });

      // Verify the update was applied by re-fetching using DB query (bypass any caching)
      const verifiedMarketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
        where: { id: marketplaceId }
      });
      
      if (!verifiedMarketplace) {
        strapi.log.error('[WEBSITE UPDATE REQUEST] Failed to verify marketplace update - listing not found after update');
        return ctx.internalServerError('Failed to verify marketplace update');
      }

      console.log('[WEBSITE UPDATE REQUEST] Verification - Marketplace listing after update (DB query):', {
        id: verifiedMarketplace.id,
        url: verifiedMarketplace.url,
        publishedAt: verifiedMarketplace.publishedAt,
        approvalStatus: verifiedMarketplace.approvalStatus,
        price: verifiedMarketplace.price,
        link_insertion_price: verifiedMarketplace.link_insertion_price,
        adv_casino_pricing: verifiedMarketplace.adv_casino_pricing,
        adv_crypto_pricing: verifiedMarketplace.adv_crypto_pricing,
        adv_cbd_pricing: verifiedMarketplace.adv_cbd_pricing,
        updatedAt: verifiedMarketplace.updatedAt
      });

      // Double-check: if price didn't update, log a warning
      if (applyData.price !== undefined && verifiedMarketplace.price !== applyData.price) {
        strapi.log.warn('[WEBSITE UPDATE REQUEST] PRICE MISMATCH!', {
          expected: applyData.price,
          actual: verifiedMarketplace.price,
          marketplaceId
        });
      }

      // Sync approved changes back to the linked publisher website for consistency in publisher portal
      if (request.publisherWebsite?.id) {
        const inverseMap = {
          price: 'generalGuestPostPrice',
          link_insertion_price: 'generalLinkInsertionPrice',
          adv_casino_pricing: 'casinoGuestPostPrice',
          adv_li_casino_pricing: 'casinoLinkInsertionPrice',
          adv_crypto_pricing: 'cryptoGuestPostPrice',
          adv_li_crypto_pricing: 'cryptoLinkInsertionPrice',
          adv_cbd_pricing: 'cbdGuestPostPrice',
          adv_li_cbd_pricing: 'cbdLinkInsertionPrice',
          adv_dating_pricing: 'datingGuestPostPrice',
          adv_li_dating_pricing: 'datingLinkInsertionPrice',
          min_word_count: 'minWordCount',
          backlink_type: 'backlinkType',
          backlink_validity: 'backlinkValidity',
          sponsored: 'sponsored',
          ugc: 'ugc',
          publisher_writing_price: 'copywritingPrice',
          category: 'category',
          language: 'language',
          countries: 'countries',
          guidelines: 'guidelines',
          tat: 'expectedTATHours' // Will convert days->hours below
        };

        const publisherUpdate = {};
        Object.entries(changes).forEach(([mkField, value]) => {
          const pwField = inverseMap[mkField];
          if (!pwField) return;
          if (mkField === 'tat') {
            const hours = typeof value === 'number' ? Math.max(0, Math.round(value * 24)) : 0;
            publisherUpdate[pwField] = hours;
          } else {
            publisherUpdate[pwField] = value;
          }
        });

        if (Object.keys(publisherUpdate).length > 0) {
          // Skip the publisher-website afterUpdate lifecycle's marketplace
          // sync — we already updated the marketplace row directly above.
          // Without this flag the lifecycle would issue a second UPDATE on
          // the same marketplace row with possibly stale-computed publisher
          // payout fields, producing a duplicate update-history entry at
          // the same timestamp.
          publisherUpdate._skipMarketplaceSync = true;
          await strapi.entityService.update('api::publisher-website.publisher-website', request.publisherWebsite.id, {
            data: publisherUpdate
          });
        }
      }

      await strapi.entityService.update('api::website-update-request.website-update-request', id, {
        data: {
          status: 'approved',
          reviewedBy: adminUser.email || adminUser.username || 'admin',
          reviewedAt: new Date(),
          dataVersion: applyData.dataVersion
        }
      });

      // Supersede other pending requests for the same marketplace listing.
      // updateMany can't filter on a relation directly in Strapi 5, so resolve
      // the older pending IDs first, then update them by primary key.
      const olderPending = await strapi.db.query('api::website-update-request.website-update-request').findMany({
        where: {
          id: { $ne: request.id },
          status: 'pending',
          marketplace: { id: marketplaceId },
        },
        select: ['id'],
      });
      if (olderPending.length > 0) {
        await strapi.db.query('api::website-update-request.website-update-request').updateMany({
          where: { id: { $in: olderPending.map((r) => r.id) } },
          data: {
            status: 'superseded',
            notes: 'Superseded because a newer request was approved'
          }
        });
      }

      return ctx.send({
        message: 'Marketplace listing updated successfully',
        data: verifiedMarketplace,
        changesApplied: Object.keys(applyData).length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      strapi.log.error('[WEBSITE UPDATE REQUEST] Approval failed', error);
      return ctx.internalServerError('Failed to approve update request');
    }
  },

  async reject(ctx) {
    try {
      const { id } = ctx.params;
      const { reason } = ctx.request.body || {};
      const adminUser = ctx.state.user;
      if (!adminUser) {
        return ctx.unauthorized('Authentication required');
      }

      const request = await strapi.entityService.findOne('api::website-update-request.website-update-request', id, {
        populate: ['publisherWebsite']
      });
      if (!request) {
        return ctx.notFound('Update request not found');
      }

      if (request.status !== 'pending') {
        return ctx.badRequest('Only pending requests can be rejected');
      }

      // Revert publisher_websites to the baseSnapshot (= last approved values
      // = what marketplace still shows). Without this, the publisher's "My
      // Websites" page keeps showing their rejected edit even though the
      // live listing was never updated, contradicting the rejection.
      //
      // baseSnapshot uses MARKETPLACE field names; map them back to
      // publisher_websites field names + unit-transform where needed.
      const VALID_BACKLINK_VALIDITY = new Set(['one_year', 'three_years', 'five_years', 'lifetime']);
      const normaliseBacklinkValidity = (v) => {
        if (v === null || v === undefined) return undefined;
        const raw = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (VALID_BACKLINK_VALIDITY.has(raw)) return raw;
        const legacy = {
          '1_year': 'one_year', '1_years': 'one_year',
          '3_year': 'three_years', '3_years': 'three_years',
          '5_year': 'five_years', '5_years': 'five_years',
          'life_time': 'lifetime', 'permanent': 'lifetime',
        };
        return legacy[raw];  // undefined when unmappable -> field is skipped
      };

      const REVERT_MAP = {
        price: { field: 'generalGuestPostPrice' },
        link_insertion_price: { field: 'generalLinkInsertionPrice' },
        adv_casino_pricing: { field: 'casinoGuestPostPrice' },
        adv_li_casino_pricing: { field: 'casinoLinkInsertionPrice' },
        adv_crypto_pricing: { field: 'cryptoGuestPostPrice' },
        adv_li_crypto_pricing: { field: 'cryptoLinkInsertionPrice' },
        adv_cbd_pricing: { field: 'cbdGuestPostPrice' },
        adv_li_cbd_pricing: { field: 'cbdLinkInsertionPrice' },
        adv_dating_pricing: { field: 'datingGuestPostPrice' },
        adv_li_dating_pricing: { field: 'datingLinkInsertionPrice' },
        // marketplace stores days, publisher_websites stores hours.
        tat: { field: 'expectedTATHours', transform: (v) => Number(v) * 24 },
        min_word_count: { field: 'minWordCount' },
        backlink_type: { field: 'backlinkType' },
        // backlink_validity: snapshots taken before the enum was normalised hold
        // DISPLAY values ("Lifetime", "1 Year") that the schema enum rejects
        // (one_year | three_years | five_years | lifetime). Writing them back
        // raw made reject() throw a ValidationError and return 500 — so an
        // admin could approve a request but never reject one. 2,709 stored
        // snapshots carry such a value. Normalise on the way back; if a value
        // cannot be mapped, drop the field rather than fail the whole revert.
        backlink_validity: { field: 'backlinkValidity', transform: (v) => normaliseBacklinkValidity(v) },
        countries: { field: 'countries' },
        language: { field: 'language' },
        category: { field: 'category' },
        guidelines: { field: 'guidelines' },
        description: { field: 'description' },
        publication_location: { field: 'publicationLocation' },
        sponsored: { field: 'sponsored' },
        ugc: { field: 'ugc' },
        publisher_writing_price: { field: 'copywritingPrice' },
        // placement_speed is derived from tat — reverting tat is enough.
      };

      const baseSnapshot = (request.baseSnapshot && typeof request.baseSnapshot === 'object') ? request.baseSnapshot : {};
      const revertData = {};
      for (const [mktField, baseValue] of Object.entries(baseSnapshot)) {
        const mapping = REVERT_MAP[mktField];
        if (!mapping) continue;
        const reverted = mapping.transform ? mapping.transform(baseValue) : baseValue;
        // A transform returning undefined means "cannot map this safely" —
        // skip the field instead of writing a value the schema will reject.
        if (reverted === undefined) {
          strapi.log.warn(`[WEBSITE UPDATE REQUEST] Skipping unmappable ${mktField}="${baseValue}" while reverting request ${id}`);
          continue;
        }
        revertData[mapping.field] = reverted;
      }

      const publisherWebsiteId = request.publisherWebsite?.id;
      if (publisherWebsiteId && Object.keys(revertData).length > 0) {
        // _skipMarketplaceSync because the publisher_websites afterUpdate
        // lifecycle would otherwise re-sync to marketplace — pointless here
        // (we're matching what marketplace already has) and noisy.
        await strapi.entityService.update('api::publisher-website.publisher-website', publisherWebsiteId, {
          data: { ...revertData, _skipMarketplaceSync: true }
        });
        strapi.log.info(`[WEBSITE UPDATE REQUEST] Reverted publisher_website ${publisherWebsiteId} (${Object.keys(revertData).length} fields) on reject of request ${id}`);
      }

      await strapi.entityService.update('api::website-update-request.website-update-request', id, {
        data: {
          status: 'rejected',
          reviewedBy: adminUser.email || adminUser.username || 'admin',
          reviewedAt: new Date(),
          notes: reason || 'Rejected by admin'
        }
      });

      return ctx.send({
        message: 'Update request rejected',
        revertedFields: Object.keys(revertData),
      });
    } catch (error) {
      strapi.log.error('[WEBSITE UPDATE REQUEST] Rejection failed', error);
      return ctx.internalServerError('Failed to reject update request');
    }
  },

  /**
   * Bulk approve / reject update requests.
   *
   * Added 2026-09-23. Until now the only way to clear the queue was
   * POST /website-update-requests/:id/approve, one at a time. A backlog of
   * 2,001 requests from one publisher sat unactioned for four months because
   * clearing it by hand meant 2,001 clicks.
   *
   * Delegates to the existing approve()/reject() handlers rather than
   * duplicating their logic, so the marketplace write, publisher_websites
   * revert, audit fields and notifications stay identical to the single-item
   * path. Each id is processed independently: one failure does not abort the
   * batch, and every outcome is reported per id.
   *
   * Body: { requestIds: number[], action: 'approve' | 'reject', notes?: string }
   */
  async bulkProcess(ctx) {
    try {
      const adminUser = ctx.state.user;
      if (!adminUser) return ctx.unauthorized('Authentication required');

      const body = (ctx.request.body && ctx.request.body.data) || ctx.request.body || {};
      const { requestIds, action } = body;
      const notes = body.notes || body.reason || '';

      if (!Array.isArray(requestIds) || requestIds.length === 0) {
        return ctx.badRequest('requestIds must be a non-empty array');
      }
      if (!['approve', 'reject'].includes(action)) {
        return ctx.badRequest("action must be either 'approve' or 'reject'");
      }
      if (action === 'reject' && !notes) {
        return ctx.badRequest('A reason is required when rejecting');
      }
      const MAX_BATCH = 2500;
      if (requestIds.length > MAX_BATCH) {
        return ctx.badRequest('Too many ids in one call (max ' + MAX_BATCH + ')');
      }

      const self = strapi.controller('api::website-update-request.website-update-request');
      const results = [];
      let succeeded = 0;
      let failed = 0;

      for (const rawId of requestIds) {
        const id = String(rawId);
        // Minimal ctx shim: the single-item handlers only read params.id,
        // request.body and state.user, and signal failure through these
        // helpers. Capturing them turns an HTTP error into a per-item result
        // instead of aborting the batch.
        let failure = null;
        const shim = {
          params: { id: id },
          state: ctx.state,
          request: { body: action === 'approve' ? { data: { notes: notes } } : { reason: notes } },
          badRequest: function (m) { failure = { message: m }; return failure; },
          notFound: function (m) { failure = { message: m }; return failure; },
          unauthorized: function (m) { failure = { message: m }; return failure; },
          internalServerError: function (m) { failure = { message: m }; return failure; },
        };

        try {
          const out = await self[action](shim);
          if (failure) {
            failed += 1;
            results.push({ id: rawId, ok: false, error: failure.message });
          } else {
            succeeded += 1;
            results.push({ id: rawId, ok: true, message: (out && out.message) || 'done' });
          }
        } catch (err) {
          failed += 1;
          results.push({ id: rawId, ok: false, error: err.message || 'Unhandled error' });
          strapi.log.error('[BULK ' + action + '] request ' + id + ' failed: ' + err.message);
        }
      }

      strapi.log.info('[BULK ' + action + '] ' + (adminUser.email || adminUser.id) + ': ' +
        succeeded + ' succeeded, ' + failed + ' failed of ' + requestIds.length);
      return { data: { action: action, total: requestIds.length, succeeded: succeeded, failed: failed, results: results } };
    } catch (error) {
      strapi.log.error('[BULK PROCESS] Unexpected failure:', error.message);
      return ctx.internalServerError('Bulk processing failed');
    }
  }
}));
