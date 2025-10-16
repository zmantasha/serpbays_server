'use strict';

/**
 * Admin Websites Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

// In-memory storage for bulk import progress (since cache might not be available)
const bulkImportProgress = new Map();

module.exports = createCoreController('api::publisher-website.publisher-website', ({ strapi }) => ({

  /**
   * Get all websites with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const { 
        page = 1, 
        pageSize = 10, // Default page size to match frontend
        sort = 'createdAt:desc',
        sortField = '',
        sortDirection = 'asc',
        search = '',
        status = '',
        userId = '',
        category = '',
        daFilter = '',
        metricsUpdateFilter = '',
        minDA = '',
        maxDA = '',
        minDR = '',
        maxDR = '',
        minTraffic = '',
        maxTraffic = '',
        minPrice = '',
        maxPrice = '',
        backlinkType = '',
        allowedLinks = '',
        minWordCount = '',
        countries = '',
        languages = '',
        verificationMethod = '',
        gscVerified = '',
        addedByReseller = '',
        recordRangeMin = '',
        recordRangeMax = ''
      } = ctx.query;

      // Build filters
      const filters = {};
      
      // Convert sort string to proper format for Strapi
      let sortObj = { createdAt: 'desc' }; // Default sort
      
      // Handle new sortField and sortDirection parameters
      if (sortField && sortDirection) {
        // Map frontend field names to database field names
        const fieldMapping = {
          'domain': 'url',
          'owner': 'currentPublisherId.username',
          'metrics': 'moz_da',
          'metrics_last_updated': 'metrics_last_updated',
          'status': 'submissionStatus',
          'price': 'generalGuestPostPrice',
          'addedDate': 'createdAt'
        };
        
        const dbField = fieldMapping[sortField] || sortField;
        sortObj = { [dbField]: sortDirection };
        console.log(`[ADMIN WEBSITES SORTING] Field: ${sortField} -> ${dbField}, Direction: ${sortDirection}`);
      } else if (sort && typeof sort === 'string') {
        // Fallback to old sort parameter
        if (sort.includes(':')) {
          const [field, direction] = sort.split(':');
          sortObj = { [field]: direction };
        } else {
          sortObj = { [sort]: 'asc' };
        }
      }
      
      // Search filter
      if (search) {
        filters.$or = [
          { url: { $containsi: search } },
          { publisherName: { $containsi: search } },
          { id: { $eq: parseInt(search) || 0 } }
        ];
      }

      // Status filter
      if (status) {
        filters.submissionStatus = status;
      }

      // User filter
      if (userId) {
        filters.$or = [
          { currentPublisherId: userId },
          { originalPublisherId: userId }
        ];
      }

      // Category filter
      if (category && category !== 'All Categories') {
        if (Array.isArray(category)) {
          filters.$or = category.map(cat => ({ category: { $contains: cat } }));
        } else {
          filters.category = { $contains: category };
        }
      }

      // DA range filter
      if (daFilter && daFilter !== 'All DA') {
        const [min, max] = daFilter.split('-').map(v => parseInt(v));
        if (!isNaN(min)) filters.moz_da = { $gte: min };
        if (!isNaN(max)) filters.moz_da = { ...filters.moz_da, $lte: max };
      }

      // Custom DA range
      if (minDA && !isNaN(parseInt(minDA))) {
        filters.moz_da = { ...filters.moz_da, $gte: parseInt(minDA) };
      }
      if (maxDA && !isNaN(parseInt(maxDA))) {
        filters.moz_da = { ...filters.moz_da, $lte: parseInt(maxDA) };
      }

      // DR range filter
      if (minDR && !isNaN(parseInt(minDR))) {
        filters.ahrefs_dr = { ...filters.ahrefs_dr, $gte: parseInt(minDR) };
      }
      if (maxDR && !isNaN(parseInt(maxDR))) {
        filters.ahrefs_dr = { ...filters.ahrefs_dr, $lte: parseInt(maxDR) };
      }

      // Traffic range filter
      if (minTraffic && !isNaN(parseInt(minTraffic))) {
        filters.ahrefs_traffic = { ...filters.ahrefs_traffic, $gte: parseInt(minTraffic) };
      }
      if (maxTraffic && !isNaN(parseInt(maxTraffic))) {
        filters.ahrefs_traffic = { ...filters.ahrefs_traffic, $lte: parseInt(maxTraffic) };
      }

      // Price range filter
      if (minPrice && !isNaN(parseInt(minPrice))) {
        filters.$or = [
          { generalGuestPostPrice: { $gte: parseInt(minPrice) } },
          { generalLinkInsertionPrice: { $gte: parseInt(minPrice) } }
        ];
      }
      if (maxPrice && !isNaN(parseInt(maxPrice))) {
        if (filters.$or) {
          filters.$or = filters.$or.map(condition => ({
            ...condition,
            $lte: parseInt(maxPrice)
          }));
        } else {
          filters.$or = [
            { generalGuestPostPrice: { $lte: parseInt(maxPrice) } },
            { generalLinkInsertionPrice: { $lte: parseInt(maxPrice) } }
          ];
        }
      }

      // Backlink type filter
      if (backlinkType && backlinkType !== 'All Types') {
        filters.backlinkType = backlinkType;
      }

      // Allowed links filter
      if (allowedLinks && allowedLinks !== 'All') {
        filters.allowedLinks = parseInt(allowedLinks);
      }

      // Min word count filter
      if (minWordCount && !isNaN(parseInt(minWordCount))) {
        filters.minWordCount = { $gte: parseInt(minWordCount) };
      }

      // Countries filter
      if (countries && countries !== 'All Countries') {
        if (Array.isArray(countries)) {
          filters.$or = countries.map(country => ({ countries: { $contains: country } }));
        } else {
          filters.countries = { $contains: countries };
        }
      }

      // Languages filter
      if (languages && languages !== 'All Languages') {
        if (Array.isArray(languages)) {
          filters.$or = languages.map(lang => ({ language: { $contains: lang } }));
        } else {
          filters.language = { $contains: languages };
        }
      }

      // Verification method filter
      if (verificationMethod && verificationMethod !== 'All Methods') {
        filters.verificationMethod = verificationMethod;
      }

      // GSC verified filter
      if (gscVerified && gscVerified !== 'All') {
        filters.gscVerified = gscVerified === 'true';
      }

      // Added by reseller filter
      if (addedByReseller && addedByReseller !== 'All') {
        filters.addedByReseller = addedByReseller === 'true';
      }

      // Metrics update filter
      if (metricsUpdateFilter && metricsUpdateFilter !== 'All Updates') {
        const now = new Date();
        if (metricsUpdateFilter === 'Never Updated') {
          filters.metrics_last_updated = { $null: true };
        } else if (metricsUpdateFilter === 'Updated Today') {
          const today = new Date(now);
          today.setHours(0, 0, 0, 0);
          filters.metrics_last_updated = { $gte: today.toISOString() };
        } else if (metricsUpdateFilter === 'Updated This Week') {
          const weekAgo = new Date(now);
          weekAgo.setDate(weekAgo.getDate() - 7);
          filters.metrics_last_updated = { $gte: weekAgo.toISOString() };
        } else if (metricsUpdateFilter === 'Updated This Month') {
          const monthAgo = new Date(now);
          monthAgo.setMonth(monthAgo.getMonth() - 1);
          filters.metrics_last_updated = { $gte: monthAgo.toISOString() };
        } else if (metricsUpdateFilter === 'Updated Long Ago') {
          const monthAgo = new Date(now);
          monthAgo.setMonth(monthAgo.getMonth() - 1);
          filters.metrics_last_updated = { $lt: monthAgo.toISOString() };
        }
      }

      console.log('[ADMIN WEBSITES FILTERS]', JSON.stringify(filters, null, 2));

      // Handle record range for limiting results
      let limit = parseInt(pageSize);
      let currentPage = parseInt(page);
      let useRecordRange = false;
      
      if (recordRangeMin && recordRangeMax) {
        const min = parseInt(recordRangeMin);
        const max = parseInt(recordRangeMax);
        if (!isNaN(min) && !isNaN(max) && min > 0 && max >= min) {
          // Record range takes precedence over pagination
          limit = max - min + 1;
          currentPage = Math.floor((min - 1) / limit) + 1;
          useRecordRange = true;
          console.log(`[ADMIN WEBSITES RECORD RANGE] Applied: ${min} to ${max}, Limit: ${limit}, Page: ${currentPage}`);
        }
      }

      // Get websites with pagination or record range
      let websites;
      if (useRecordRange) {
        // Use raw database query for record range to ensure proper limiting
        const offset = parseInt(recordRangeMin) - 1;
        websites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
          where: filters,
          orderBy: sortObj,
          limit: limit,
          offset: offset,
          populate: ['currentPublisherId', 'originalPublisherId']
        });
        console.log(`[ADMIN WEBSITES RECORD RANGE] Raw query: offset=${offset}, limit=${limit}, results=${websites.length}`);
      } else {
        // Use normal pagination with raw database query for better control
        console.log(`[ADMIN WEBSITES PAGINATION] Page: ${currentPage}, PageSize: ${limit}`);
        const offset = (currentPage - 1) * limit;
        
        websites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
          where: filters,
          orderBy: sortObj,
          limit: limit,
          offset: offset,
          populate: ['currentPublisherId', 'originalPublisherId']
        });
        
        console.log(`[ADMIN WEBSITES PAGINATION RESULT] Received ${websites.length} websites (offset: ${offset}, limit: ${limit})`);
      }

      // Get total count for pagination
      const total = await strapi.db.query('api::publisher-website.publisher-website').count({ where: filters });

      // Debug: Check what's actually in the database
      const allWebsites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        populate: ['currentPublisherId', 'originalPublisherId']
      });
      
      console.log('[ADMIN WEBSITES DEBUG]', {
        total,
        websitesCount: websites.length,
        filtersApplied: Object.keys(filters).length
      });

      // Transform data to match frontend expectations with comprehensive fields
      const transformedWebsites = websites.map(website => ({
        id: website.id,
        domain: website.url || 'N/A',
        title: website.publisherName || 'N/A',
        description: website.description || 'No description available',
        status: website.submissionStatus || 'pending',
        traffic: website.moz_da || 'N/A',
        addedDate: website.createdAt,
        owner: {
          id: website.currentPublisherId?.id || website.originalPublisherId?.id || 0,
          username: website.currentPublisherId?.username || website.originalPublisherId?.username || 'Unknown',
          email: website.currentPublisherId?.email || website.originalPublisherId?.email || 'N/A'
        },
        // SEO Metrics
        metrics: {
          da: website.moz_da || 0,
          dr: website.ahrefs_dr || 0,
          traffic: website.ahrefs_traffic || 0,
          backlinks: website.ahrefs_referring_domain || 0,
          organicKeywords: website.ahrefs_keywords || 0,
          pageSpeed: website.pageSpeed || 'Normal',
          mobileFriendly: website.mobileFriendly || true,
          ssl: website.ssl || true,
          // Additional metrics fields
          ahrefs_rank: website.ahrefs_rank || 0,
          semrush_authority_score: website.semrush_authority_score || 0,
          moz_spam_score: website.moz_spam_score || 0,
          semrush_traffic: website.semrush_traffic || 0
        },
        // Pricing information
        pricing: {
          general: {
            guestPost: website.generalGuestPostPrice || 0,
            linkInsertion: website.generalLinkInsertionPrice || 0
          },
          casino: {
            accepted: website.casinoAccepted || false,
            guestPost: website.casinoGuestPostPrice || 0,
            linkInsertion: website.casinoLinkInsertionPrice || 0
          },
          crypto: {
            accepted: website.cryptoAccepted || false,
            guestPost: website.cryptoGuestPostPrice || 0,
            linkInsertion: website.cryptoLinkInsertionPrice || 0
          },
          cbd: {
            accepted: website.cbdAccepted || false,
            guestPost: website.cbdGuestPostPrice || 0,
            linkInsertion: website.cbdLinkInsertionPrice || 0
          },
          dating: {
            accepted: website.datingAccepted || false,
            guestPost: website.datingGuestPostPrice || 0,
            linkInsertion: website.datingLinkInsertionPrice || 0
          },
          copywriting: {
            offered: website.doCopywriting || false,
            price: website.copywritingPrice || 0
          }
        },
        // Content requirements
        content: {
          minWordCount: website.minWordCount || 500,
          backlinkType: website.backlinkType || 'Do follow',
          allowedLinks: website.allowedLinks || 1,
          backlinkValidity: website.backlinkValidity || 'one_year',
          sponsored: website.sponsored || false,
          ugc: website.ugc || false,
          isPRSite: website.isPRSite || false
        },
        // Categories and targeting
        categories: website.category || [],
        countries: website.countries || ['United States'],
        languages: website.language || ['English'],
        // Verification and technical
        gscVerified: website.gscVerified || false,
        gscVerifiedAt: website.gscVerifiedAt,
        gscPermissionLevel: website.gscPermissionLevel,
        verificationMethod: website.verificationMethod,
        // Turnaround time
        tatHours: website.expectedTATHours || 168,
        // Sample posts
        samplePosts: website.samplePosts || [],
        // Guidelines
        guidelines: website.guidelines || 'No guidelines provided',
        // Additional metadata
        protocol: website.protocol || 'https',
        resellerCode: website.resellerCode,
        addedByReseller: website.addedByReseller || false,
        // SEO Metrics tracking
        metrics_last_updated: website.metrics_last_updated,
        metrics_update_count: website.metrics_update_count || 0,
        metrics_update_method: website.metrics_update_method
      }));
      
      console.log('[ADMIN WEBSITES FIND]', {
        total,
        websitesCount: websites.length,
        transformedCount: transformedWebsites.length,
        sampleWebsite: transformedWebsites[0]
      });

      ctx.send({
        data: transformedWebsites,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount: Math.ceil(total / pageSize),
            total
          }
        }
      });

    } catch (error) {
      console.error('[ADMIN WEBSITES FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch websites');
    }
  },

  /**
   * Get single website with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;

      const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: {
          currentPublisherId: {
            fields: ['id', 'username', 'email']
          },
          originalPublisherId: {
            fields: ['id', 'username', 'email']
          }
        }
      });

      if (!website) {
        return ctx.notFound('Website not found');
      }

      // Transform data to match frontend expectations with all detailed fields
      const transformedWebsite = {
        id: website.id,
        domain: website.url || 'N/A',
        title: website.publisherName || 'N/A',
        description: website.description || 'No description available',
        status: website.submissionStatus || 'pending',
        traffic: website.moz_da || 'N/A',
        addedDate: website.createdAt,
        owner: {
          id: website.currentPublisherId?.id || website.originalPublisherId?.id || 0,
          username: website.currentPublisherId?.username || website.originalPublisherId?.username || 'Unknown',
          email: website.currentPublisherId?.email || website.originalPublisherId?.email || 'N/A'
        },
        // Pricing information
        pricing: {
          general: {
            guestPost: website.generalGuestPostPrice || 0,
            linkInsertion: website.generalLinkInsertionPrice || 0
          },
          casino: {
            accepted: website.casinoAccepted || false,
            guestPost: website.casinoGuestPostPrice || 0,
            linkInsertion: website.casinoLinkInsertionPrice || 0
          },
          crypto: {
            accepted: website.cryptoAccepted || false,
            guestPost: website.cryptoGuestPostPrice || 0,
            linkInsertion: website.cryptoLinkInsertionPrice || 0
          },
          cbd: {
            accepted: website.cbdAccepted || false,
            guestPost: website.cbdGuestPostPrice || 0,
            linkInsertion: website.cbdLinkInsertionPrice || 0
          },
          dating: {
            accepted: website.datingAccepted || false,
            guestPost: website.datingGuestPostPrice || 0,
            linkInsertion: website.datingLinkInsertionPrice || 0
          },
          copywriting: {
            offered: website.doCopywriting || false,
            price: website.copywritingPrice || 0
          }
        },
        // Content requirements
        content: {
          minWordCount: website.minWordCount || 500,
          backlinkType: website.backlinkType || 'Do follow',
          allowedLinks: website.allowedLinks || 1,
          backlinkValidity: website.backlinkValidity || 'one_year',
          sponsored: website.sponsored || false,
          ugc: website.ugc || false,
          isPRSite: website.isPRSite || false
        },
        // Categories and targeting
        categories: website.category || [],
        countries: website.countries || ['United States'],
        languages: website.language || ['English'],
        // Verification and technical
        gscVerified: website.gscVerified || false,
        gscVerifiedAt: website.gscVerifiedAt,
        gscPermissionLevel: website.gscPermissionLevel,
        verificationMethod: website.verificationMethod,
        // Turnaround time
        tatHours: website.expectedTATHours || 168,
        // Sample posts
        samplePosts: website.samplePosts || [],
        // Guidelines
        guidelines: website.guidelines || 'No guidelines provided',
        rejectionReason: website.rejectionReason || null,
        rejectedBy: website.rejectedBy || null,
        // Additional metadata
        protocol: website.protocol || 'https',
        resellerCode: website.resellerCode,
        addedByReseller: website.addedByReseller || false,
        // SEO Metrics (placeholder for future API integration)
        ahrefs_dr: website.ahrefs_dr || null,
        ahrefs_traffic: website.ahrefs_traffic || null,
        ahrefs_rank: website.ahrefs_rank || null,
        moz_da: website.moz_da || null,
        semrush_authority_score: website.semrush_authority_score || null,
        semrush_traffic: website.semrush_traffic || null,
        moz_spam_score: website.moz_spam_score || null,
        ahrefs_referring_domain: website.ahrefs_referring_domain || null,
        ahrefs_keywords: website.ahrefs_keywords || null,
        metrics_last_updated: website.metrics_last_updated || null,
        metrics_update_count: website.metrics_update_count || 0,
        metrics_update_method: website.metrics_update_method || null
      };

      console.log('[ADMIN WEBSITE FIND ONE]', {
        websiteId: id,
        originalWebsite: website,
        transformedWebsite: transformedWebsite
      });

      ctx.send({
        data: transformedWebsite
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE FIND ONE ERROR]', error);
      return ctx.internalServerError('Failed to fetch website details');
    }
  },

  /**
   * Approve website (admin action)
   */
  async approve(ctx) {
    try {
      const { id } = ctx.params;
      const { adminNotes } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} approving website ${id}`);

      const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: { 
          submissionStatus: 'approved',
          adminNotes,
          approvedAt: new Date(),
          approvedBy: ctx.state.user.id
        },
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      // Add the approved website to the marketplace
      if (updatedWebsite.url) {
        console.log(`[ADMIN ACTION] Adding approved website ${updatedWebsite.url} to marketplace`);
        
        try {
          // Check if marketplace record already exists
          const existingMarketplaceRecord = await strapi.entityService.findMany('api::marketplace.marketplace', {
            filters: { url: updatedWebsite.url },
            limit: 1
          });

          if (existingMarketplaceRecord && existingMarketplaceRecord.length > 0) {
            console.log(`[ADMIN ACTION] Marketplace record already exists for website ${updatedWebsite.url}, updating it`);
            
            // Update existing marketplace record
            await strapi.entityService.update('api::marketplace.marketplace', existingMarketplaceRecord[0].id, {
              data: {
                status: 'active',
                updatedAt: new Date()
              }
            });
          } else {
            console.log(`[ADMIN ACTION] Creating new marketplace record for website ${updatedWebsite.url}`);
            
            // Create new marketplace record
            await strapi.entityService.create('api::marketplace.marketplace', {
              data: {
                url: updatedWebsite.url,
                status: 'active',
                publisherWebsite: updatedWebsite.id,
                createdAt: new Date(),
                updatedAt: new Date()
              }
            });
          }
          
          console.log(`[ADMIN ACTION] Successfully added website ${updatedWebsite.url} to marketplace`);
        } catch (marketplaceError) {
          console.error(`[ADMIN ACTION] Error adding website ${updatedWebsite.url} to marketplace:`, marketplaceError);
          // Don't fail the approval if marketplace creation fails
        }
      }

      // Transform data to match frontend expectations with all detailed fields
      const transformedWebsite = {
        id: updatedWebsite.id,
        domain: updatedWebsite.url || 'N/A',
        title: updatedWebsite.publisherName || 'N/A',
        description: updatedWebsite.description || 'No description available',
        status: updatedWebsite.submissionStatus || 'pending',
        traffic: updatedWebsite.moz_da || 'N/A',
        addedDate: updatedWebsite.createdAt,
        owner: {
          id: updatedWebsite.currentPublisherId?.id || updatedWebsite.originalPublisherId?.id || 0,
          username: updatedWebsite.currentPublisherId?.username || updatedWebsite.originalPublisherId?.username || 'Unknown',
          email: updatedWebsite.currentPublisherId?.email || updatedWebsite.originalPublisherId?.email || 'N/A'
        },
        // Pricing information
        pricing: {
          general: {
            guestPost: updatedWebsite.generalGuestPostPrice || 0,
            linkInsertion: updatedWebsite.generalLinkInsertionPrice || 0
          },
          casino: {
            accepted: updatedWebsite.casinoAccepted || false,
            guestPost: updatedWebsite.casinoGuestPostPrice || 0,
            linkInsertion: updatedWebsite.casinoLinkInsertionPrice || 0
          },
          crypto: {
            accepted: updatedWebsite.cryptoAccepted || false,
            guestPost: updatedWebsite.cryptoGuestPostPrice || 0,
            linkInsertion: updatedWebsite.cryptoLinkInsertionPrice || 0
          },
          cbd: {
            accepted: updatedWebsite.cbdAccepted || false,
            guestPost: updatedWebsite.cbdGuestPostPrice || 0,
            linkInsertion: updatedWebsite.cbdLinkInsertionPrice || 0
          },
          dating: {
            accepted: updatedWebsite.datingAccepted || false,
            guestPost: updatedWebsite.datingGuestPostPrice || 0,
            linkInsertion: updatedWebsite.datingLinkInsertionPrice || 0
          },
          copywriting: {
            offered: updatedWebsite.doCopywriting || false,
            price: updatedWebsite.copywritingPrice || 0
          }
        },
        // Content requirements
        content: {
          minWordCount: updatedWebsite.minWordCount || 500,
          backlinkType: updatedWebsite.backlinkType || 'Do follow',
          allowedLinks: updatedWebsite.allowedLinks || 1,
          backlinkValidity: updatedWebsite.backlinkValidity || 'one_year',
          sponsored: updatedWebsite.sponsored || false,
          ugc: updatedWebsite.ugc || false,
          isPRSite: updatedWebsite.isPRSite || false
        },
        // Categories and targeting
        categories: updatedWebsite.category || [],
        countries: updatedWebsite.countries || ['United States'],
        languages: updatedWebsite.language || ['English'],
        // Verification and technical
        gscVerified: updatedWebsite.gscVerified || false,
        gscVerifiedAt: updatedWebsite.gscVerifiedAt,
        gscPermissionLevel: updatedWebsite.gscPermissionLevel,
        verificationMethod: updatedWebsite.verificationMethod,
        // Turnaround time
        tatHours: updatedWebsite.expectedTATHours || 168,
        // Sample posts
        samplePosts: updatedWebsite.samplePosts || [],
        // Guidelines
        guidelines: updatedWebsite.guidelines || 'No guidelines provided',
        // Additional metadata
        protocol: updatedWebsite.protocol || 'https',
        resellerCode: updatedWebsite.resellerCode,
        addedByReseller: updatedWebsite.addedByReseller || false,
        // SEO Metrics (placeholder for future API integration)
        ahrefsDR: updatedWebsite.ahrefsDR || null,
        ahrefsTraffic: updatedWebsite.ahrefsTraffic || null,
        ahrefsRank: updatedWebsite.ahrefsRank || null,
        ahrefsReferringDomains: updatedWebsite.ahrefsReferringDomains || null,
        mozDA: updatedWebsite.mozDA || null,
        mozSpamScore: updatedWebsite.mozSpamScore || null,
        mozTrustFlow: updatedWebsite.mozTrustFlow || null,
        semrushTraffic: updatedWebsite.semrushTraffic || null,
        semrushAuthorityScore: updatedWebsite.semrushAuthorityScore || null,
        semrushKeywords: updatedWebsite.semrushKeywords || null
      };

      ctx.send({
        data: transformedWebsite
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE APPROVE ERROR]', error);
      return ctx.internalServerError('Failed to approve website');
    }
  },

  /**
   * Reject website (admin action)
   */
  async reject(ctx) {
    try {
      const { id } = ctx.params;
      const { reason } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} rejecting website ${id}. Reason: ${reason}`);

      // Get the website before updating to check if it was previously approved
      const websiteBeforeUpdate = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      const wasPreviouslyApproved = websiteBeforeUpdate.submissionStatus === 'approved';
      const websiteUrl = websiteBeforeUpdate.url;

      const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: { 
          submissionStatus: 'rejected',
          rejectionReason: reason,
          rejectedAt: new Date(),
          rejectedBy: ctx.state.user.id
        },
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      // If the website was previously approved, remove it from the marketplace
      if (wasPreviouslyApproved && websiteUrl) {
        console.log(`[ADMIN ACTION] Website ${websiteUrl} was previously approved, removing from marketplace`);
        
        try {
          // Find and remove the marketplace record
          const marketplaceRecord = await strapi.entityService.findMany('api::marketplace.marketplace', {
            filters: { url: websiteUrl },
            limit: 1
          });

          if (marketplaceRecord && marketplaceRecord.length > 0) {
            const marketplaceId = marketplaceRecord[0].id;
            console.log(`[ADMIN ACTION] Removing marketplace record ${marketplaceId} for website ${websiteUrl}`);
            
            await strapi.entityService.delete('api::marketplace.marketplace', marketplaceId);
            console.log(`[ADMIN ACTION] Successfully removed marketplace record for website ${websiteUrl}`);
            
            // Log the action for audit purposes
            console.log(`[ADMIN AUDIT] Website ${websiteUrl} (ID: ${id}) rejected and removed from marketplace by admin ${ctx.state.user.id} at ${new Date().toISOString()}. Reason: ${reason}`);
          } else {
            console.log(`[ADMIN ACTION] No marketplace record found for website ${websiteUrl}`);
          }
        } catch (marketplaceError) {
          console.error(`[ADMIN ACTION] Error removing marketplace record for website ${websiteUrl}:`, marketplaceError);
          // Don't fail the rejection if marketplace removal fails
        }
      } else if (!wasPreviouslyApproved) {
        console.log(`[ADMIN ACTION] Website ${websiteUrl} was not previously approved (status: ${websiteBeforeUpdate.submissionStatus}), no marketplace action needed`);
      }

      // Transform data to match frontend expectations
      const transformedWebsite = {
        id: updatedWebsite.id,
        domain: updatedWebsite.url || 'N/A',
        title: updatedWebsite.publisherName || 'N/A',
        description: updatedWebsite.description || 'No description available',
        status: updatedWebsite.submissionStatus || 'pending',
        traffic: updatedWebsite.moz_da || 'N/A',
        addedDate: updatedWebsite.createdAt,
        owner: {
          id: updatedWebsite.currentPublisherId?.id || updatedWebsite.originalPublisherId?.id || 0,
          username: updatedWebsite.currentPublisherId?.username || updatedWebsite.originalPublisherId?.username || 'Unknown',
          email: updatedWebsite.currentPublisherId?.email || updatedWebsite.originalPublisherId?.email || 'N/A'
        }
      };

      ctx.send({
        data: transformedWebsite
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE REJECT ERROR]', error);
      return ctx.internalServerError('Failed to reject website');
    }
  },

  /**
   * Create new website
   */
  async create(ctx) {
    try {
      const websiteData = ctx.request.body;

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} creating new website`, websiteData);
    

      // Prepare the data with proper defaults and transformations
      const preparedData = {
        url: websiteData.url,
        protocol: 'https',
        publisherEmail: websiteData.publisherEmail || 'admin@serpbays.com', // Required field
        publisherName: websiteData.publisherName,
        description: websiteData.description,
        submissionStatus: websiteData.submissionStatus || 'approval_pending',
        publisherType: websiteData.publisherType,
        verificationMethod: websiteData.publisherType === 'gsc-verified' ? 'google-search-console' : 'reseller-code',
        addedByReseller: websiteData.publisherType === 'reseller',
        gscVerified: websiteData.publisherType === 'gsc-verified',
        gscVerifiedAt: websiteData.publisherType === 'gsc-verified' ? new Date() : null,
        // Set publisher relations if selectedUserId is provided
        currentPublisherId: websiteData.selectedUserId ? parseInt(websiteData.selectedUserId) : null,
        originalPublisherId: websiteData.selectedUserId ? parseInt(websiteData.selectedUserId) : null,
        generalGuestPostPrice: parseInt(websiteData.generalGuestPostPrice) || 0,
        generalLinkInsertionPrice: parseInt(websiteData.generalLinkInsertionPrice) || 0,
        expectedTATHours: parseInt(websiteData.expectedTATHours) || 168,
        minWordCount: parseInt(websiteData.minWordCount) || 500,
        category: websiteData.category || ['General'],
        countries: websiteData.countries || ['United States'],
        language: websiteData.language || ['English'],
        backlinkType: websiteData.backlinkType || 'Do follow',
        backlinkValidity: websiteData.backlinkValidity || 'three_years',
        allowedLinks: parseInt(websiteData.allowedLinks) || 1,
        sponsored: Boolean(websiteData.sponsored),
        ugc: Boolean(websiteData.ugc),
        isPRSite: Boolean(websiteData.isPRSite),
        doCopywriting: Boolean(websiteData.doCopywriting),
        copywritingPrice: parseInt(websiteData.copywritingPrice) || 0,
        casinoAccepted: Boolean(websiteData.casinoAccepted),
        casinoGuestPostPrice: parseInt(websiteData.casinoGuestPostPrice) || 0,
        casinoLinkInsertionPrice: parseInt(websiteData.casinoLinkInsertionPrice) || 0,
        cryptoAccepted: Boolean(websiteData.cryptoAccepted),
        cryptoGuestPostPrice: parseInt(websiteData.cryptoGuestPostPrice) || 0,
        cryptoLinkInsertionPrice: parseInt(websiteData.cryptoLinkInsertionPrice) || 0,
        cbdAccepted: Boolean(websiteData.cbdAccepted),
        cbdGuestPostPrice: parseInt(websiteData.cbdGuestPostPrice) || 0,
        cbdLinkInsertionPrice: parseInt(websiteData.cbdLinkInsertionPrice) || 0,
        datingAccepted: Boolean(websiteData.datingAccepted),
        datingGuestPostPrice: parseInt(websiteData.datingGuestPostPrice) || 0,
        datingLinkInsertionPrice: parseInt(websiteData.datingLinkInsertionPrice) || 0,
        samplePosts: websiteData.samplePosts || [],
        guidelines: websiteData.guidelines,
        stepCompleted: 4, // Mark as completed since admin is adding it
        urlAddedAt: new Date(),
        detailsCompletedAt: new Date()
      };

      console.log('Prepared data for website creation:', preparedData);

      // Create the new website
      const newWebsite = await strapi.entityService.create('api::publisher-website.publisher-website', {
        data: preparedData,
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      // Transform data to match frontend expectations
      const transformedWebsite = {
        id: newWebsite.id,
        domain: newWebsite.url || 'N/A',
        title: newWebsite.publisherName || 'N/A',
        description: newWebsite.description || 'No description available',
        status: newWebsite.submissionStatus || 'pending',
        traffic: newWebsite.moz_da || 'N/A',
        addedDate: newWebsite.createdAt,
        owner: {
          id: newWebsite.currentPublisherId?.id || newWebsite.originalPublisherId?.id || 0,
          username: newWebsite.currentPublisherId?.username || newWebsite.originalPublisherId?.username || 'Unknown',
          email: newWebsite.currentPublisherId?.email || newWebsite.originalPublisherId?.email || 'N/A'
        }
      };

      ctx.send({
        data: transformedWebsite
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE CREATE ERROR]', error);
      return ctx.internalServerError('Failed to create website');
    }
  },

  /**
   * Update website (general update)
   */
  async update(ctx) {
    try {
      const { id } = ctx.params;
      const updateData = ctx.request.body;

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} updating website ${id}`, updateData);

      // Map frontend field names to database field names
      const mappedData = {
        url: updateData.url,
        publisherName: updateData.publisherName,
        description: updateData.description,
        submissionStatus: updateData.submissionStatus,
        moz_da: updateData.moz_da,
        ahrefs_dr: updateData.ahrefs_dr,
        ahrefs_traffic: updateData.ahrefs_traffic,
        ahrefs_rank: updateData.ahrefs_rank,
        semrush_authority_score: updateData.semrush_authority_score,
        moz_spam_score: updateData.moz_spam_score,
        ahrefs_referring_domain: updateData.ahrefs_referring_domain,
        ahrefs_keywords: updateData.ahrefs_keywords,
        semrush_traffic: updateData.semrush_traffic,
        generalGuestPostPrice: updateData.generalGuestPostPrice,
        generalLinkInsertionPrice: updateData.generalLinkInsertionPrice,
        expectedTATHours: updateData.expectedTATHours,
        minWordCount: updateData.minWordCount,
        category: updateData.category,
        countries: updateData.countries,
        language: updateData.language,
        backlinkType: updateData.backlinkType,
        backlinkValidity: updateData.backlinkValidity,
        allowedLinks: updateData.allowedLinks,
        sponsored: updateData.sponsored,
        ugc: updateData.ugc,
        isPRSite: updateData.isPRSite,
        doCopywriting: updateData.doCopywriting,
        copywritingPrice: updateData.copywritingPrice,
        casinoAccepted: updateData.casinoAccepted,
        casinoGuestPostPrice: updateData.casinoGuestPostPrice,
        casinoLinkInsertionPrice: updateData.casinoLinkInsertionPrice,
        cryptoAccepted: updateData.cryptoAccepted,
        cryptoGuestPostPrice: updateData.cryptoGuestPostPrice,
        cryptoLinkInsertionPrice: updateData.cryptoLinkInsertionPrice,
        cbdAccepted: updateData.cbdAccepted,
        cbdGuestPostPrice: updateData.cbdGuestPostPrice,
        cbdLinkInsertionPrice: updateData.cbdLinkInsertionPrice,
        datingAccepted: updateData.datingAccepted,
        datingGuestPostPrice: updateData.datingGuestPostPrice,
        datingLinkInsertionPrice: updateData.datingLinkInsertionPrice,
        samplePosts: updateData.samplePosts,
        guidelines: updateData.guidelines
      };

      // Remove undefined values
      Object.keys(mappedData).forEach(key => {
        if (mappedData[key] === undefined) {
          delete mappedData[key];
        }
      });

      console.log(`[ADMIN ACTION] Mapped update data:`, mappedData);

      // Update the website
      const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: mappedData,
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      // Transform data to match frontend expectations
      const transformedWebsite = {
        id: updatedWebsite.id,
        domain: updatedWebsite.url || 'N/A',
        title: updatedWebsite.publisherName || 'N/A',
        description: updatedWebsite.description || 'No description available',
        status: updatedWebsite.submissionStatus || 'pending',
        traffic: updatedWebsite.moz_da || 'N/A',
        addedDate: updatedWebsite.createdAt,
        owner: {
          id: updatedWebsite.currentPublisherId?.id || updatedWebsite.originalPublisherId?.id || 0,
          username: updatedWebsite.currentPublisherId?.username || updatedWebsite.originalPublisherId?.username || 'Unknown',
          email: updatedWebsite.currentPublisherId?.email || updatedWebsite.originalPublisherId?.email || 'N/A'
        }
      };

      ctx.send({
        data: transformedWebsite
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE UPDATE ERROR]', error);
      return ctx.internalServerError('Failed to update website');
    }
  },

  /**
   * Update SEO metrics for a website
   */
  async updateMetrics(ctx) {
    try {
      const { id } = ctx.params;
      const metricsData = ctx.request.body;

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} updating metrics for website ${id}`, metricsData);

      // Add metrics update tracking
      const updateData = {
        ...metricsData,
        metrics_last_updated: new Date(),
        metrics_update_count: (metricsData.metrics_update_count || 0) + 1,
        metrics_update_method: 'manual'
      };

      // Update publisher-website collection
      const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: updateData,
        populate: ['currentPublisherId', 'originalPublisherId']
      });

      // Check if this is an ownership transfer and handle marketplace update accordingly
      const websiteUrl = updatedWebsite.url;
      if (websiteUrl) {
        const marketplaceRecord = await strapi.entityService.findMany('api::marketplace.marketplace', {
          filters: { url: websiteUrl },
          limit: 1
        });

        if (marketplaceRecord && marketplaceRecord.length > 0) {
          const marketplaceId = marketplaceRecord[0].id;
          
          // Check if this is an ownership transfer
          if (updatedWebsite.submissionStatus === 'ownership_transferred') {
            console.log(`[ADMIN ACTION] Website ${websiteUrl} has ownership transferred status`);
            
            // Find the verified publisher's website (not the ownership transfer record)
            const verifiedPublisherWebsite = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
              filters: { 
                url: websiteUrl,
                submissionStatus: 'approved',
                gscVerified: true,
                $not: { submissionStatus: 'ownership_transferred' }
              },
              populate: ['currentPublisherId'],
              limit: 1
            });

            if (verifiedPublisherWebsite && verifiedPublisherWebsite.length > 0) {
              const verifiedWebsite = verifiedPublisherWebsite[0];
              console.log(`[ADMIN ACTION] Found verified publisher website ${verifiedWebsite.id} for ${websiteUrl}`);
              
              // Use metrics from the verified publisher's website, not the ownership transfer record
              const updateDataMarketplace = {
                ahrefs_dr: verifiedWebsite.ahrefs_dr || metricsData.ahrefs_dr,
                ahrefs_traffic: verifiedWebsite.ahrefs_traffic || metricsData.ahrefs_traffic,
                ahrefs_rank: verifiedWebsite.ahrefs_rank || metricsData.ahrefs_rank,
                moz_da: verifiedWebsite.moz_da || metricsData.moz_da,
                semrush_authority_score: verifiedWebsite.semrush_authority_score || metricsData.semrush_authority_score,
                semrush_traffic: verifiedWebsite.semrush_traffic || metricsData.semrush_traffic,
                moz_spam_score: verifiedWebsite.moz_spam_score || metricsData.moz_spam_score,
                ahrefs_referring_domain: verifiedWebsite.ahrefs_referring_domain || metricsData.ahrefs_referring_domain,
                ahrefs_keywords: verifiedWebsite.ahrefs_keywords || metricsData.ahrefs_keywords,
                metrics_last_updated: new Date(),
                metrics_update_count: (verifiedWebsite.metrics_update_count || 0) + 1,
                metrics_update_method: 'ownership_transfer_verified'
              };

              await strapi.entityService.update('api::marketplace.marketplace', marketplaceId, {
                data: updateDataMarketplace
              });

              console.log(`[ADMIN ACTION] Updated marketplace record ${marketplaceId} with verified publisher metrics for ${websiteUrl}`);
            } else {
              console.log(`[ADMIN ACTION] No verified publisher website found for ${websiteUrl}, skipping marketplace update`);
            }
          } else {
            // Normal website (not ownership transfer) - update marketplace with current metrics
            const updateDataMarketplace = {
              ahrefs_dr: metricsData.ahrefs_dr,
              ahrefs_traffic: metricsData.ahrefs_traffic,
              ahrefs_rank: metricsData.ahrefs_rank,
              moz_da: metricsData.moz_da,
              semrush_authority_score: metricsData.semrush_authority_score,
              semrush_traffic: metricsData.semrush_traffic,
              moz_spam_score: metricsData.moz_spam_score,
              ahrefs_referring_domain: metricsData.ahrefs_referring_domain,
              ahrefs_keywords: metricsData.ahrefs_keywords,
              metrics_last_updated: new Date(),
              metrics_update_count: (metricsData.metrics_update_count || 0) + 1,
              metrics_update_method: 'manual'
            };

            await strapi.entityService.update('api::marketplace.marketplace', marketplaceId, {
              data: updateDataMarketplace
            });

            console.log(`[ADMIN ACTION] Updated marketplace record ${marketplaceId} for website ${websiteUrl}`);
          }
        } else {
          console.log(`[ADMIN ACTION] No marketplace record found for website ${websiteUrl}`);
        }
      }

      // Transform data to match frontend expectations
      const transformedWebsite = {
        id: updatedWebsite.id,
        domain: updatedWebsite.url || 'N/A',
        title: updatedWebsite.publisherName || 'N/A',
        description: updatedWebsite.description || 'No description available',
        status: updatedWebsite.submissionStatus || 'pending',
        traffic: updatedWebsite.moz_da || 'N/A',
        addedDate: updatedWebsite.createdAt,
        owner: {
          id: updatedWebsite.currentPublisherId?.id || updatedWebsite.originalPublisherId?.id || 0,
          username: updatedWebsite.currentPublisherId?.username || updatedWebsite.originalPublisherId?.username || 'Unknown',
          email: updatedWebsite.currentPublisherId?.email || updatedWebsite.originalPublisherId?.email || 'N/A'
        },
        // Pricing information
        pricing: {
          general: {
            guestPost: updatedWebsite.generalGuestPostPrice || 0,
            linkInsertion: updatedWebsite.generalLinkInsertionPrice || 0
          },
          casino: {
            accepted: updatedWebsite.casinoAccepted || false,
            guestPost: updatedWebsite.casinoGuestPostPrice || 0,
            linkInsertion: updatedWebsite.casinoLinkInsertionPrice || 0
          },
          crypto: {
            accepted: updatedWebsite.cryptoAccepted || false,
            guestPost: updatedWebsite.cryptoGuestPostPrice || 0,
            linkInsertion: updatedWebsite.cryptoLinkInsertionPrice || 0
          },
          cbd: {
            accepted: updatedWebsite.cbdAccepted || false,
            guestPost: updatedWebsite.cbdGuestPostPrice || 0,
            linkInsertion: updatedWebsite.cbdLinkInsertionPrice || 0
          },
          dating: {
            accepted: updatedWebsite.datingAccepted || false,
            guestPost: updatedWebsite.datingGuestPostPrice || 0,
            linkInsertion: updatedWebsite.datingLinkInsertionPrice || 0
          },
          copywriting: {
            offered: updatedWebsite.doCopywriting || false,
            price: updatedWebsite.copywritingPrice || 0
          }
        },
        // Content requirements
        content: {
          minWordCount: updatedWebsite.minWordCount || 500,
          backlinkType: updatedWebsite.backlinkType || 'Do follow',
          allowedLinks: updatedWebsite.allowedLinks || 1,
          backlinkValidity: updatedWebsite.backlinkValidity || 'one_year',
          sponsored: updatedWebsite.sponsored || false,
          ugc: updatedWebsite.ugc || false,
          isPRSite: updatedWebsite.isPRSite || false
        },
        // Categories and targeting
        categories: updatedWebsite.category || [],
        countries: updatedWebsite.countries || ['United States'],
        languages: updatedWebsite.language || ['English'],
        // Verification and technical
        gscVerified: updatedWebsite.gscVerified || false,
        gscVerifiedAt: updatedWebsite.gscVerifiedAt,
        gscPermissionLevel: updatedWebsite.gscPermissionLevel,
        verificationMethod: updatedWebsite.verificationMethod,
        // Turnaround time
        tatHours: updatedWebsite.expectedTATHours || 168,
        // Sample posts
        samplePosts: updatedWebsite.samplePosts || [],
        // Guidelines
        guidelines: updatedWebsite.guidelines || 'No guidelines provided',
        // Additional metadata
        protocol: updatedWebsite.protocol || 'https',
        resellerCode: updatedWebsite.resellerCode,
        addedByReseller: updatedWebsite.addedByReseller || false,
        // SEO Metrics (placeholder for future API integration)
        ahrefs_dr: updatedWebsite.ahrefs_dr || null,
        ahrefs_traffic: updatedWebsite.ahrefs_traffic || null,
        ahrefs_rank: updatedWebsite.ahrefs_rank || null,
        ahrefs_referring_domain: updatedWebsite.ahrefs_referring_domain || null,
        moz_da: updatedWebsite.moz_da || null,
        moz_spam_score: updatedWebsite.moz_spam_score || null,
        semrush_traffic: updatedWebsite.semrush_traffic || null,
        semrush_authority_score: updatedWebsite.semrush_authority_score || null,
        ahrefs_keywords: updatedWebsite.ahrefs_keywords || null,
        // Metrics tracking
        metrics_last_updated: updatedWebsite.metrics_last_updated || null,
        metrics_update_count: updatedWebsite.metrics_update_count || 0,
        metrics_update_method: updatedWebsite.metrics_update_method || null
      };

      ctx.send({
        data: transformedWebsite
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE UPDATE METRICS ERROR]', error);
      return ctx.internalServerError('Failed to update website metrics');
    }
  },

  /**
   * Get website statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      console.log('[ADMIN WEBSITE STATS] Method called');
      
      // Check cache first (5-minute cache)
      const cacheKey = 'website-stats-cache'
      const cachedStats = await strapi.cache?.get(cacheKey)
      
      if (cachedStats) {
        console.log('[ADMIN WEBSITE STATS] Returning cached stats')
        return ctx.send(cachedStats)
      }
      
      // Get counts by status in parallel for better performance
      const [total, pending, approved, rejected] = await Promise.all([
        strapi.db.query('api::publisher-website.publisher-website').count(),
        strapi.db.query('api::publisher-website.publisher-website').count({
          where: { submissionStatus: 'approval_pending' }
        }),
        strapi.db.query('api::publisher-website.publisher-website').count({
          where: { submissionStatus: 'approved' }
        }),
        strapi.db.query('api::publisher-website.publisher-website').count({
          where: { submissionStatus: 'rejected' }
        })
      ]);
      
      console.log('[ADMIN WEBSITE STATS] Counts:', { total, pending, approved, rejected });

      // Get new websites this month
      const thisMonth = new Date();
      thisMonth.setDate(1);
      thisMonth.setHours(0, 0, 0, 0);

      const newThisMonth = await strapi.db.query('api::publisher-website.publisher-website').count({
        where: {
          createdAt: {
            $gte: thisMonth.toISOString()
          }
        }
      });

      const statsData = {
        totalWebsites: total,
        pendingWebsites: pending,
        approvedWebsites: approved,
        rejectedWebsites: rejected,
        newThisMonth
      };
      
      console.log('[ADMIN WEBSITE STATS]', statsData);
      
      // Cache the results for 5 minutes
      if (strapi.cache) {
        await strapi.cache.set(cacheKey, { data: statsData }, { ttl: 300 }) // 5 minutes
      }
      
      ctx.send({
        data: statsData
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch website statistics');
    }
  },

  /**
   * Bulk update metrics from CSV import
   */
  async bulkUpdateMetrics(ctx) {
    try {
      const { websites } = ctx.request.body;
      
      console.log("websites", websites)
      if (!Array.isArray(websites) || websites.length === 0) {
        ctx.throw(400, 'No websites data provided');
      }

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} bulk updating metrics for ${websites.length} websites`);

      const results = [];
      const errors = [];

      for (const websiteData of websites) {
        try {
          const { id, domain, notes, ...metricsData } = websiteData;
          
          if (!id) {
            errors.push({ id: 'unknown', error: 'Missing website ID' });
            continue;
          }
          console.log("id", id)
          console.log("Metrics data to update:", metricsData)

          // Fetch existing website to get current metrics_update_count
          const existingWebsite = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
          
          if (!existingWebsite) {
            errors.push({ id, error: 'Website not found' });
            continue;
          }

          // Add metrics update tracking
          const updateData = {
            ...metricsData,
            metrics_last_updated: new Date(),
            metrics_update_count: (existingWebsite.metrics_update_count || 0) + 1,
            metrics_update_method: 'bulk_import'
          };
          console.log("Update data:", updateData)

          const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
            data: updateData
          });
          console.log("Updated website:", updatedWebsite)

          // Also update the corresponding marketplace record with ownership transfer logic
          const websiteUrl = updatedWebsite.url;
          if (websiteUrl) {
            try {
              const marketplaceRecord = await strapi.entityService.findMany('api::marketplace.marketplace', {
                filters: { url: websiteUrl },
                limit: 1
              });

              if (marketplaceRecord && marketplaceRecord.length > 0) {
                const marketplaceId = marketplaceRecord[0].id;
                
                // Check if this is an ownership transfer
                if (updatedWebsite.submissionStatus === 'ownership_transferred') {
                  console.log(`[ADMIN ACTION] Website ${websiteUrl} has ownership transferred status in bulk update`);
                  
                  // Find the verified publisher's website (not the ownership transfer record)
                  const verifiedPublisherWebsite = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
                    filters: { 
                      url: websiteUrl,
                      submissionStatus: 'approved',
                      gscVerified: true,
                      $not: { submissionStatus: 'ownership_transferred' }
                    },
                    limit: 1
                  });

                  if (verifiedPublisherWebsite && verifiedPublisherWebsite.length > 0) {
                    const verifiedWebsite = verifiedPublisherWebsite[0];
                    console.log(`[ADMIN ACTION] Found verified publisher website ${verifiedWebsite.id} for ${websiteUrl} in bulk update`);
                    
                    // Use metrics from the verified publisher's website, not the ownership transfer record
                    const updateDataMarketplace = {
                      ahrefs_dr: verifiedWebsite.ahrefs_dr || metricsData.ahrefs_dr,
                      ahrefs_traffic: verifiedWebsite.ahrefs_traffic || metricsData.ahrefs_traffic,
                      ahrefs_rank: verifiedWebsite.ahrefs_rank || metricsData.ahrefs_rank,
                      moz_da: verifiedWebsite.moz_da || metricsData.moz_da,
                      semrush_authority_score: verifiedWebsite.semrush_authority_score || metricsData.semrush_authority_score,
                      semrush_traffic: verifiedWebsite.semrush_traffic || metricsData.semrush_traffic,
                      moz_spam_score: verifiedWebsite.moz_spam_score || metricsData.moz_spam_score,
                      ahrefs_referring_domain: verifiedWebsite.ahrefs_referring_domain || metricsData.ahrefs_referring_domain,
                      ahrefs_keywords: verifiedWebsite.ahrefs_keywords || metricsData.ahrefs_keywords,
                      metrics_last_updated: new Date(),
                      metrics_update_count: (verifiedWebsite.metrics_update_count || 0) + 1,
                      metrics_update_method: 'bulk_import_ownership_transfer_verified'
                    };

                    await strapi.entityService.update('api::marketplace.marketplace', marketplaceId, {
                      data: updateDataMarketplace
                    });

                    console.log(`[ADMIN ACTION] Updated marketplace record ${marketplaceId} with verified publisher metrics for ${websiteUrl} in bulk update`);
                  } else {
                    console.log(`[ADMIN ACTION] No verified publisher website found for ${websiteUrl} in bulk update, skipping marketplace update`);
                  }
                } else {
                  // Normal website (not ownership transfer) - update marketplace with current metrics
                  const updateDataMarketplace = {
                    ahrefs_dr: metricsData.ahrefs_dr,
                    ahrefs_traffic: metricsData.ahrefs_traffic,
                    ahrefs_rank: metricsData.ahrefs_rank,
                    moz_da: metricsData.moz_da,
                    semrush_authority_score: metricsData.semrush_authority_score,
                    semrush_traffic: metricsData.semrush_traffic,
                    moz_spam_score: metricsData.moz_spam_score,
                    ahrefs_referring_domain: metricsData.ahrefs_referring_domain,
                    ahrefs_keywords: metricsData.ahrefs_keywords,
                    metrics_last_updated: new Date(),
                    metrics_update_count: (metricsData.metrics_update_count || 0) + 1,
                    metrics_update_method: 'bulk_import'
                  };

                  await strapi.entityService.update('api::marketplace.marketplace', marketplaceId, {
                    data: updateDataMarketplace
                  });

                  console.log(`[ADMIN ACTION] Updated marketplace record ${marketplaceId} for website ${websiteUrl} in bulk update`);
                }
              } else {
                console.log(`[ADMIN ACTION] No marketplace record found for website ${websiteUrl}`);
              }
            } catch (marketplaceError) {
              console.error(`[ADMIN ACTION] Error updating marketplace for website ${websiteUrl}:`, marketplaceError);
              // Don't fail the entire bulk update for marketplace sync errors
            }
          }

          results.push({
            id: updatedWebsite.id,
            domain: updatedWebsite.url,
            status: 'updated'
          });
        } catch (error) {
          console.error(`[ADMIN ACTION] Error updating website ${websiteData.id}:`, error);
          errors.push({ 
            id: websiteData.id || 'unknown', 
            error: error.message 
          });
        }
      }

      console.log(`[ADMIN ACTION] Bulk update completed: ${results.length} successful, ${errors.length} errors`);

     return ctx.send({
        success: true,
        updated: results.length,
        errors: errors.length,
        results,
        errorDetails: errors
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE BULK UPDATE METRICS ERROR]', error);
      return ctx.internalServerError('Failed to perform bulk metrics update');
    }
  },

  /**
   * Check for website conflicts before creation
   */
  async checkConflict(ctx) {
    try {
      const { url, publisherType } = ctx.query

      if (!url) {
        return ctx.badRequest('URL is required')
      }

      // If no publisher type provided, use a default for checking
      const checkPublisherType = publisherType || 'gsc-verified'
      console.log('[BACKEND CONFLICT CHECK] Checking URL:', url, 'with publisher type:', checkPublisherType)

      // Find existing APPROVED website with the same URL (only check against active websites)
      const existingWebsite = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters: { 
          url: url,
          submissionStatus: 'approved' // Only check against active websites
        },
        populate: {
          currentPublisherId: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          },
          originalPublisherId: {
            fields: ['id', 'username', 'email', 'firstName', 'lastName']
          }
        }
      })

      // Debug: Check what websites exist with this URL regardless of status
      const allWebsitesWithUrl = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters: { url: url },
        fields: ['id', 'url', 'submissionStatus', 'verificationMethod', 'addedByReseller', 'publisherName']
      })
      console.log('[CONFLICT CHECK DEBUG] All websites with URL:', url, ':', allWebsitesWithUrl.map(w => ({
        id: w.id,
        status: w.submissionStatus,
        verificationMethod: w.verificationMethod,
        addedByReseller: w.addedByReseller
      })))

      console.log('[CONFLICT CHECK] Found websites with URL:', url, 'Status filter: submissionStatus = approved')
      console.log('[CONFLICT CHECK] Results:', existingWebsite.length, 'websites found')
      
      if (existingWebsite.length === 0) {
        console.log('[CONFLICT CHECK] No approved websites found - no conflict')
        return ctx.send({
          hasConflict: false
        })
      }

      console.log('[CONFLICT CHECK] Found existing website:', {
        id: existingWebsite[0].id,
        url: existingWebsite[0].url,
        submissionStatus: existingWebsite[0].submissionStatus,
        verificationMethod: existingWebsite[0].verificationMethod,
        addedByReseller: existingWebsite[0].addedByReseller,
        publisherName: existingWebsite[0].publisherName
      })

      const existing = existingWebsite[0]
      const isExistingGSC = existing.verificationMethod === 'google-search-console'
      const isNewGSC = checkPublisherType === 'gsc-verified'
      const isExistingReseller = existing.addedByReseller === true
      const isNewReseller = checkPublisherType === 'reseller'

      // Debug logging
      console.log('[CONFLICT CHECK DEBUG]', {
        existingVerificationMethod: existing.verificationMethod,
        existingAddedByReseller: existing.addedByReseller,
        newPublisherType: checkPublisherType,
        isExistingGSC,
        isNewGSC,
        isExistingReseller,
        isNewReseller
      })

      let conflictType = null
      let message = ''
      let canReplace = false

      // Determine conflict type and business rules
      if (isExistingGSC && isNewGSC) {
        // GSC vs GSC - can replace
        conflictType = 'gsc-vs-gsc'
        message = 'Website already exists as GSC verified. Do you want to replace it?'
        canReplace = true
      } else if (isExistingGSC && isNewReseller) {
        // GSC vs Reseller - CANNOT replace (business rule)
        conflictType = 'reseller-vs-gsc'
        message = 'Cannot replace GSC verified site with reseller site. GSC verified sites have higher authority.'
        canReplace = false
      } else if (isExistingReseller && isNewGSC) {
        // Reseller vs GSC - can replace (GSC has higher authority)
        conflictType = 'gsc-vs-reseller'
        message = 'Website already exists as reseller site. GSC verified sites have higher authority. Do you want to replace it?'
        canReplace = true
      } else if (isExistingReseller && isNewReseller) {
        // Reseller vs Reseller - can replace
        conflictType = 'reseller-vs-reseller'
        message = 'Website already exists as reseller site. Do you want to replace it?'
        canReplace = true
      }

      // Debug logging for conflict resolution
      console.log('[CONFLICT RESOLUTION]', {
        conflictType,
        message,
        canReplace
      })

      return ctx.send({
        hasConflict: true,
        conflictType,
        existingWebsite: existing,
        message,
        canReplace
      })

    } catch (error) {
      console.error('[ADMIN WEBSITES CHECK CONFLICT ERROR]', error)
      return ctx.internalServerError('Failed to check website conflicts')
    }
  },

  /**
   * Replace existing website with new data
   */
  async replaceWebsite(ctx) {
    try {
      const { id } = ctx.params
      const newWebsiteData = ctx.request.body

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} replacing website ${id}`)

      // Get existing website to verify it exists
      const existingWebsite = await strapi.entityService.findOne('api::publisher-website.publisher-website', id)
      
      if (!existingWebsite) {
        return ctx.notFound('Website not found')
      }

      // Prepare the data with only valid fields (same as create method)
      const preparedData = {
        url: newWebsiteData.url,
        protocol: newWebsiteData.protocol || 'https',
        publisherEmail: newWebsiteData.publisherEmail || existingWebsite.publisherEmail,
        publisherName: newWebsiteData.publisherName,
        description: newWebsiteData.description,
        submissionStatus: newWebsiteData.submissionStatus || existingWebsite.submissionStatus,
        publisherType: newWebsiteData.publisherType,
        verificationMethod: newWebsiteData.publisherType === 'gsc-verified' ? 'google-search-console' : 'reseller-code',
        addedByReseller: newWebsiteData.publisherType === 'reseller',
        gscVerified: newWebsiteData.publisherType === 'gsc-verified',
        gscVerifiedAt: newWebsiteData.publisherType === 'gsc-verified' ? new Date() : null,
        generalGuestPostPrice: parseInt(newWebsiteData.generalGuestPostPrice) || 0,
        generalLinkInsertionPrice: parseInt(newWebsiteData.generalLinkInsertionPrice) || 0,
        expectedTATHours: parseInt(newWebsiteData.expectedTATHours) || 168,
        minWordCount: parseInt(newWebsiteData.minWordCount) || 500,
        category: newWebsiteData.category || ['General'],
        countries: newWebsiteData.countries || ['United States'],
        language: newWebsiteData.language || ['English'],
        backlinkType: newWebsiteData.backlinkType || 'Do follow',
        backlinkValidity: newWebsiteData.backlinkValidity || 'three_years',
        allowedLinks: parseInt(newWebsiteData.allowedLinks) || 1,
        sponsored: Boolean(newWebsiteData.sponsored),
        ugc: Boolean(newWebsiteData.ugc),
        isPRSite: Boolean(newWebsiteData.isPRSite),
        doCopywriting: Boolean(newWebsiteData.doCopywriting),
        copywritingPrice: parseInt(newWebsiteData.copywritingPrice) || 0,
        casinoAccepted: Boolean(newWebsiteData.casinoAccepted),
        casinoGuestPostPrice: parseInt(newWebsiteData.casinoGuestPostPrice) || 0,
        casinoLinkInsertionPrice: parseInt(newWebsiteData.casinoLinkInsertionPrice) || 0,
        cryptoAccepted: Boolean(newWebsiteData.cryptoAccepted),
        cryptoGuestPostPrice: parseInt(newWebsiteData.cryptoGuestPostPrice) || 0,
        cryptoLinkInsertionPrice: parseInt(newWebsiteData.cryptoLinkInsertionPrice) || 0,
        cbdAccepted: Boolean(newWebsiteData.cbdAccepted),
        cbdGuestPostPrice: parseInt(newWebsiteData.cbdGuestPostPrice) || 0,
        cbdLinkInsertionPrice: parseInt(newWebsiteData.cbdLinkInsertionPrice) || 0,
        datingAccepted: Boolean(newWebsiteData.datingAccepted),
        datingGuestPostPrice: parseInt(newWebsiteData.datingGuestPostPrice) || 0,
        datingLinkInsertionPrice: parseInt(newWebsiteData.datingLinkInsertionPrice) || 0,
        samplePosts: newWebsiteData.samplePosts || [],
        guidelines: newWebsiteData.guidelines,
        updatedAt: new Date()
      };

      console.log('Prepared data for website replacement:', preparedData);

      // Update the website with new data
      const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: preparedData
      })

      return ctx.send({
        data: updatedWebsite,
        message: 'Website replaced successfully'
      })

    } catch (error) {
      console.error('[ADMIN WEBSITES REPLACE ERROR]', error)
      return ctx.internalServerError('Failed to replace website')
    }
  },

  /**
   * Get bulk import progress for current user
   */
  async getBulkImportProgress(ctx) {
    try {
      // Check authentication
      if (!ctx.state.user || !ctx.state.user.id) {
        console.log('[BULK IMPORT PROGRESS] Unauthenticated request')
        return ctx.send({
          total: 0,
          processed: 0,
          percent: 0,
          active: false
        })
      }
      
      const userId = ctx.state.user.id
      const progress = bulkImportProgress.get(`user-${userId}`)
      
      if (!progress) {
        return ctx.send({
          total: 0,
          processed: 0,
          percent: 0,
          active: false
        })
      }
      
      return ctx.send({
        ...progress,
        active: true
      })
    } catch (error) {
      console.error('[GET BULK IMPORT PROGRESS ERROR]', error)
      // Return empty progress instead of error to prevent breaking the frontend
      return ctx.send({
        total: 0,
        processed: 0,
        percent: 0,
        active: false
      })
    }
  },

  /**
   * Bulk import websites from CSV data
   */
  async bulkImport(ctx) {
    try {
      const { websites } = ctx.request.body
      
      if (!Array.isArray(websites) || websites.length === 0) {
        return ctx.badRequest('No websites data provided')
      }

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} bulk importing ${websites.length} websites`)

      const results = {
        total: websites.length,
        successful: 0,
        errors: 0,
        conflicts: 0,
        duplicates: 0,
        details: []
      }

      // Process websites in batches to avoid memory issues with large datasets
      const batchSize = 100
      const batches = []
      for (let i = 0; i < websites.length; i += batchSize) {
        batches.push(websites.slice(i, i + batchSize))
      }

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex]
        
        for (let i = 0; i < batch.length; i++) {
          const websiteData = batch[i]
          
          try {
            // Normalize URL
            const normalizeUrl = (url) => {
              if (!url.trim()) return ''
              let normalized = url.trim()
              try {
                if (normalized.includes('://') || normalized.startsWith('//')) {
                  if (!normalized.includes('://')) {
                    normalized = 'https:' + normalized
                  }
                  const urlObj = new URL(normalized)
                  normalized = urlObj.hostname
                  normalized = normalized.replace(/^www\./i, '')
                  return normalized
                } else {
                  normalized = normalized.replace(/^\/+/, '')
                  normalized = normalized.split('/')[0]
                  normalized = normalized.split('?')[0]
                  normalized = normalized.split('#')[0]
                  normalized = normalized.replace(/\.+$/, '')
                  return normalized
                }
              } catch (error) {
                let fallback = url.trim()
                fallback = fallback.replace(/^https?:\/\//i, '')
                fallback = fallback.replace(/^\/+/, '')
                fallback = fallback.replace(/^www\./i, '')
                fallback = fallback.split('/')[0]
                fallback = fallback.replace(/\.+$/, '')
                return fallback
              }
            }

            const normalizedUrl = normalizeUrl(websiteData.url || '')
            if (!normalizedUrl) {
              results.errors++
              results.details.push({
                url: websiteData.url || 'N/A',
                status: 'error',
                message: 'Invalid URL format'
              })
              continue
            }

            // Duplicate detection: if URL already exists in DB (any status), mark as duplicate and skip
            const existingAny = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
              filters: { url: normalizedUrl },
              populate: {
                currentPublisherId: {
                  fields: ['id', 'username', 'email', 'firstName', 'lastName']
                },
                originalPublisherId: {
                  fields: ['id', 'username', 'email', 'firstName', 'lastName']
                }
              }
            })

            if (Array.isArray(existingAny) && existingAny.length > 0) {
              const ex = existingAny[0]
              results.duplicates++
              results.details.push({
                url: normalizedUrl,
                status: 'duplicate',
                message: 'Website already exists. Skipped importing.',
                existing: {
                  id: ex.id,
                  url: ex.url,
                  submissionStatus: ex.submissionStatus,
                  publisherType: ex.publisherType,
                  verificationMethod: ex.verificationMethod,
                  addedByReseller: ex.addedByReseller,
                  publisherEmail: ex.publisherEmail,
                  publisherName: ex.publisherName,
                  description: ex.description,
                  generalGuestPostPrice: ex.generalGuestPostPrice,
                  generalLinkInsertionPrice: ex.generalLinkInsertionPrice,
                  expectedTATHours: ex.expectedTATHours,
                  minWordCount: ex.minWordCount,
                  category: ex.category,
                  countries: ex.countries,
                  language: ex.language,
                  backlinkType: ex.backlinkType,
                  backlinkValidity: ex.backlinkValidity,
                  allowedLinks: ex.allowedLinks,
                  sponsored: ex.sponsored,
                  ugc: ex.ugc,
                  isPRSite: ex.isPRSite,
                  doCopywriting: ex.doCopywriting,
                  copywritingPrice: ex.copywritingPrice,
                  casinoAccepted: ex.casinoAccepted,
                  casinoGuestPostPrice: ex.casinoGuestPostPrice,
                  casinoLinkInsertionPrice: ex.casinoLinkInsertionPrice,
                  cryptoAccepted: ex.cryptoAccepted,
                  cryptoGuestPostPrice: ex.cryptoGuestPostPrice,
                  cryptoLinkInsertionPrice: ex.cryptoLinkInsertionPrice,
                  cbdAccepted: ex.cbdAccepted,
                  cbdGuestPostPrice: ex.cbdGuestPostPrice,
                  cbdLinkInsertionPrice: ex.cbdLinkInsertionPrice,
                  datingAccepted: ex.datingAccepted,
                  datingGuestPostPrice: ex.datingGuestPostPrice,
                  datingLinkInsertionPrice: ex.datingLinkInsertionPrice,
                  samplePosts: ex.samplePosts,
                  guidelines: ex.guidelines,
                  createdAt: ex.createdAt,
                  updatedAt: ex.updatedAt
                }
              })
              continue
            }

            // Check for conflicts using the same logic as single import (approved-only replacement policy)
            const publisherType = websiteData.publisherType || 'reseller'
            const existingWebsite = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
              filters: { 
                url: normalizedUrl,
                submissionStatus: 'approved'
              },
              populate: {
                currentPublisherId: {
                  fields: ['id', 'username', 'email', 'firstName', 'lastName']
                },
                originalPublisherId: {
                  fields: ['id', 'username', 'email', 'firstName', 'lastName']
                }
              }
            })

            // Apply business rules for conflict resolution
            if (existingWebsite.length > 0) {
              const existing = existingWebsite[0]
              const isExistingGSC = existing.verificationMethod === 'google-search-console'
              const isNewGSC = publisherType === 'gsc-verified'
              const isExistingReseller = existing.addedByReseller === true
              const isNewReseller = publisherType === 'reseller'

              let canReplace = false
              let conflictMessage = ''

              if (isExistingGSC && isNewGSC) {
                // GSC vs GSC - can replace
                canReplace = true
                conflictMessage = 'GSC verified site replaced with new GSC verified site'
              } else if (isExistingGSC && isNewReseller) {
                // GSC vs Reseller - CANNOT replace
                canReplace = false
                conflictMessage = 'Cannot replace GSC verified site with reseller site'
              } else if (isExistingReseller && isNewGSC) {
                // Reseller vs GSC - can replace
                canReplace = true
                conflictMessage = 'Reseller site replaced with GSC verified site'
              } else if (isExistingReseller && isNewReseller) {
                // Reseller vs Reseller - can replace
                canReplace = true
                conflictMessage = 'Reseller site replaced with new reseller site'
              }

              if (!canReplace) {
                results.conflicts++
                results.details.push({
                  url: normalizedUrl,
                  status: 'conflict',
                  message: conflictMessage
                })
                continue
              } else {
                // Replace existing website
                const preparedData = this.prepareWebsiteData(websiteData, normalizedUrl)
                await strapi.entityService.update('api::publisher-website.publisher-website', existing.id, {
                  data: preparedData
                })
                
                results.successful++
                results.details.push({
                  url: normalizedUrl,
                  status: 'success',
                  message: `Replaced existing website: ${conflictMessage}`
                })
                continue
              }
            }

            // No conflict - create new website
            const preparedData = this.prepareWebsiteData(websiteData, normalizedUrl)
            await strapi.entityService.create('api::publisher-website.publisher-website', {
              data: preparedData
            })
            
            results.successful++
            results.details.push({
              url: normalizedUrl,
              status: 'success',
              message: 'Website created successfully'
            })

          } catch (error) {
            console.error(`[BULK IMPORT] Error processing website ${websiteData.url}:`, error)
            results.errors++
            
            // Extract more detailed error information
            let errorMessage = error.message || 'Unknown error occurred'
            if (error.details && error.details.errors && Array.isArray(error.details.errors)) {
              const validationErrors = error.details.errors.map(e => `${e.path?.join('.') || 'field'}: ${e.message}`).join(', ')
              errorMessage = `Validation error: ${validationErrors}`
            }
            
            results.details.push({
              url: websiteData.url || 'N/A',
              status: 'error',
              message: errorMessage
            })
          }
        }
        
        // Log progress and store in memory map
        const processed = (batchIndex + 1) * batchSize
        const totalProcessed = Math.min(processed, websites.length)
        const progressPercent = Math.round((totalProcessed / websites.length) * 100)
        console.log(`[BULK IMPORT] Progress: ${totalProcessed}/${websites.length} (${progressPercent}%)`)
        
        // Store progress in memory map
        if (ctx.state.user && ctx.state.user.id) {
          bulkImportProgress.set(`user-${ctx.state.user.id}`, {
            total: websites.length,
            processed: totalProcessed,
            percent: progressPercent,
            timestamp: Date.now()
          })
        }
      }

      console.log(`[BULK IMPORT] Completed: ${results.successful} successful, ${results.errors} errors, ${results.conflicts} conflicts`)

      // Clear progress from memory map
      if (ctx.state.user && ctx.state.user.id) {
        bulkImportProgress.delete(`user-${ctx.state.user.id}`)
      }

      return ctx.send(results)

    } catch (error) {
      console.error('[ADMIN WEBSITES BULK IMPORT ERROR]', error)
      return ctx.internalServerError('Failed to process bulk import')
    }
  },

  // Helper method to prepare website data (extracted from create method)
  prepareWebsiteData(websiteData, normalizedUrl) {
    const publisherType = websiteData.publisherType || 'reseller'
    
    // Normalize backlinkType to match schema enum values
    const normalizeBacklinkType = (value) => {
      if (!value) return 'Do follow' // Default value
      
      const normalized = String(value).trim().toLowerCase()
      
      // Handle various input formats
      if (normalized === 'dofollow' || normalized === 'do follow' || normalized === 'do_follow' || 
          normalized === 'follow' || normalized === '1' || normalized === 'true' || normalized === 'yes') {
        return 'Do follow'
      } else if (normalized === 'nofollow' || normalized === 'no follow' || normalized === 'no_follow' || 
                 normalized === '0' || normalized === 'false' || normalized === 'no') {
        return 'No follow'
      }
      
      // If it doesn't match any known pattern, default to 'Do follow'
      console.warn(`Unknown backlinkType value: "${value}", defaulting to "Do follow"`)
      return 'Do follow'
    }
    
    return {
      url: normalizedUrl,
      protocol: 'https',
      publisherEmail: websiteData.publisherEmail || 'admin@serpbays.com',
      publisherName: websiteData.publisherName || 'Unknown Publisher',
      description: websiteData.description || 'Bulk imported website',
      submissionStatus: 'approval_pending',
      publisherType: publisherType,
      verificationMethod: publisherType === 'gsc-verified' ? 'google-search-console' : 'reseller-code',
      addedByReseller: publisherType === 'reseller',
      gscVerified: publisherType === 'gsc-verified',
      gscVerifiedAt: publisherType === 'gsc-verified' ? new Date() : null,
      generalGuestPostPrice: parseInt(websiteData.generalGuestPostPrice) || 0,
      generalLinkInsertionPrice: parseInt(websiteData.generalLinkInsertionPrice) || 0,
      expectedTATHours: parseInt(websiteData.expectedTATHours) || 168,
      minWordCount: parseInt(websiteData.minWordCount) || 500,
      category: websiteData.category ? websiteData.category.split(',').map(c => c.trim()) : ['General'],
      countries: websiteData.countries ? websiteData.countries.split(',').map(c => c.trim()) : ['United States'],
      language: websiteData.language ? websiteData.language.split(',').map(l => l.trim()) : ['English'],
      backlinkType: normalizeBacklinkType(websiteData.backlinkType),
      backlinkValidity: websiteData.backlinkValidity || 'three_years',
      allowedLinks: parseInt(websiteData.allowedLinks) || 1,
      sponsored: websiteData.sponsored === 'true' || websiteData.sponsored === true,
      ugc: websiteData.ugc === 'true' || websiteData.ugc === true,
      isPRSite: websiteData.isPRSite === 'true' || websiteData.isPRSite === true,
      doCopywriting: websiteData.doCopywriting === 'true' || websiteData.doCopywriting === true,
      copywritingPrice: parseInt(websiteData.copywritingPrice) || 0,
      casinoAccepted: websiteData.casinoAccepted === 'true' || websiteData.casinoAccepted === true,
      casinoGuestPostPrice: parseInt(websiteData.casinoGuestPostPrice) || 0,
      casinoLinkInsertionPrice: parseInt(websiteData.casinoLinkInsertionPrice) || 0,
      cryptoAccepted: websiteData.cryptoAccepted === 'true' || websiteData.cryptoAccepted === true,
      cryptoGuestPostPrice: parseInt(websiteData.cryptoGuestPostPrice) || 0,
      cryptoLinkInsertionPrice: parseInt(websiteData.cryptoLinkInsertionPrice) || 0,
      cbdAccepted: websiteData.cbdAccepted === 'true' || websiteData.cbdAccepted === true,
      cbdGuestPostPrice: parseInt(websiteData.cbdGuestPostPrice) || 0,
      cbdLinkInsertionPrice: parseInt(websiteData.cbdLinkInsertionPrice) || 0,
      datingAccepted: websiteData.datingAccepted === 'true' || websiteData.datingAccepted === true,
      datingGuestPostPrice: parseInt(websiteData.datingGuestPostPrice) || 0,
      datingLinkInsertionPrice: parseInt(websiteData.datingLinkInsertionPrice) || 0,
      samplePosts: websiteData.samplePosts ? websiteData.samplePosts.split(',').map(s => s.trim()) : [],
      guidelines: websiteData.guidelines || 'No guidelines provided',
      stepCompleted: 4,
      urlAddedAt: new Date(),
      detailsCompletedAt: new Date()
    }
  },

  /**
   * Export websites with filters to CSV
   */
  async exportFiltered(ctx) {
    try {
      const { 
        search = '',
        status = '',
        category = '',
        daFilter = '',
        metricsUpdateFilter = '',
        minDA = '',
        maxDA = '',
        minDR = '',
        maxDR = '',
        minTraffic = '',
        maxTraffic = '',
        minPrice = '',
        maxPrice = '',
        backlinkType = '',
        allowedLinks = '',
        minWordCount = '',
        countries = '',
        languages = '',
        verificationMethod = '',
        gscVerified = '',
        addedByReseller = '',
        recordRangeMin = '',
        recordRangeMax = '',
        sort = 'createdAt:desc'
      } = ctx.query;

      // Build comprehensive filters
      const filters = {};
      
      // Convert sort string to proper format for Strapi
      let sortObj = { createdAt: 'desc' }; // Default sort
      if (sort && typeof sort === 'string') {
        if (sort.includes(':')) {
          const [field, direction] = sort.split(':');
          sortObj = { [field]: direction };
        } else {
          sortObj = { [sort]: 'asc' };
        }
      }
      
      // Search filter
      if (search) {
        filters.$or = [
          { url: { $containsi: search } },
          { publisherName: { $containsi: search } },
          { description: { $containsi: search } },
          { id: { $eq: parseInt(search) || 0 } }
        ];
      }

      // Status filter
      if (status && status !== 'All Status') {
        filters.submissionStatus = status;
      }

      // Category filter
      if (category && category !== 'All Categories') {
        if (Array.isArray(category)) {
          filters.$or = category.map(cat => ({ category: { $contains: cat } }));
        } else {
          filters.category = { $contains: category };
        }
      }

      // DA range filter
      if (daFilter && daFilter !== 'All DA') {
        const [min, max] = daFilter.split('-').map(v => parseInt(v));
        if (!isNaN(min)) filters.moz_da = { $gte: min };
        if (!isNaN(max)) filters.moz_da = { ...filters.moz_da, $lte: max };
      }

      // Custom DA range
      if (minDA && !isNaN(parseInt(minDA))) {
        filters.moz_da = { ...filters.moz_da, $gte: parseInt(minDA) };
      }
      if (maxDA && !isNaN(parseInt(maxDA))) {
        filters.moz_da = { ...filters.moz_da, $lte: parseInt(maxDA) };
      }

      // DR range filter
      if (minDR && !isNaN(parseInt(minDR))) {
        filters.ahrefs_dr = { ...filters.ahrefs_dr, $gte: parseInt(minDR) };
      }
      if (maxDR && !isNaN(parseInt(maxDR))) {
        filters.ahrefs_dr = { ...filters.ahrefs_dr, $lte: parseInt(maxDR) };
      }

      // Traffic range filter
      if (minTraffic && !isNaN(parseInt(minTraffic))) {
        filters.ahrefs_traffic = { ...filters.ahrefs_traffic, $gte: parseInt(minTraffic) };
      }
      if (maxTraffic && !isNaN(parseInt(maxTraffic))) {
        filters.ahrefs_traffic = { ...filters.ahrefs_traffic, $lte: parseInt(maxTraffic) };
      }

      // Price range filter
      if (minPrice && !isNaN(parseInt(minPrice))) {
        filters.$or = [
          { generalGuestPostPrice: { $gte: parseInt(minPrice) } },
          { generalLinkInsertionPrice: { $gte: parseInt(minPrice) } }
        ];
      }
      if (maxPrice && !isNaN(parseInt(maxPrice))) {
        if (filters.$or) {
          filters.$or = filters.$or.map(condition => ({
            ...condition,
            $lte: parseInt(maxPrice)
          }));
        } else {
          filters.$or = [
            { generalGuestPostPrice: { $lte: parseInt(maxPrice) } },
            { generalLinkInsertionPrice: { $lte: parseInt(maxPrice) } }
          ];
        }
      }

      // Backlink type filter
      if (backlinkType && backlinkType !== 'All Types') {
        filters.backlinkType = backlinkType;
      }

      // Allowed links filter
      if (allowedLinks && allowedLinks !== 'All') {
        filters.allowedLinks = parseInt(allowedLinks);
      }

      // Min word count filter
      if (minWordCount && !isNaN(parseInt(minWordCount))) {
        filters.minWordCount = { $gte: parseInt(minWordCount) };
      }

      // Countries filter
      if (countries && countries !== 'All Countries') {
        if (Array.isArray(countries)) {
          filters.$or = countries.map(country => ({ countries: { $contains: country } }));
        } else {
          filters.countries = { $contains: countries };
        }
      }

      // Languages filter
      if (languages && languages !== 'All Languages') {
        if (Array.isArray(languages)) {
          filters.$or = languages.map(lang => ({ language: { $contains: lang } }));
        } else {
          filters.language = { $contains: languages };
        }
      }

      // Verification method filter
      if (verificationMethod && verificationMethod !== 'All Methods') {
        filters.verificationMethod = verificationMethod;
      }

      // GSC verified filter
      if (gscVerified && gscVerified !== 'All') {
        filters.gscVerified = gscVerified === 'true';
      }

      // Added by reseller filter
      if (addedByReseller && addedByReseller !== 'All') {
        filters.addedByReseller = addedByReseller === 'true';
      }

      // Metrics update filter
      if (metricsUpdateFilter && metricsUpdateFilter !== 'All Updates') {
        const now = new Date();
        if (metricsUpdateFilter === 'Never Updated') {
          filters.metrics_last_updated = { $null: true };
        } else if (metricsUpdateFilter === 'Updated Today') {
          const today = new Date(now);
          today.setHours(0, 0, 0, 0);
          filters.metrics_last_updated = { $gte: today.toISOString() };
        } else if (metricsUpdateFilter === 'Updated This Week') {
          const weekAgo = new Date(now);
          weekAgo.setDate(weekAgo.getDate() - 7);
          filters.metrics_last_updated = { $gte: weekAgo.toISOString() };
        } else if (metricsUpdateFilter === 'Updated This Month') {
          const monthAgo = new Date(now);
          monthAgo.setMonth(monthAgo.getMonth() - 1);
          filters.metrics_last_updated = { $gte: monthAgo.toISOString() };
        } else if (metricsUpdateFilter === 'Updated Long Ago') {
          const monthAgo = new Date(now);
          monthAgo.setMonth(monthAgo.getMonth() - 1);
          filters.metrics_last_updated = { $lt: monthAgo.toISOString() };
        }
      }

      console.log('Export filters:', JSON.stringify(filters, null, 2));

      // Handle record range for export
      let limit = null;
      let useRecordRange = false;
      
      if (recordRangeMin && recordRangeMax) {
        const min = parseInt(recordRangeMin);
        const max = parseInt(recordRangeMax);
        if (!isNaN(min) && !isNaN(max) && min > 0 && max >= min) {
          limit = max - min + 1;
          useRecordRange = true;
          console.log(`[EXPORT RECORD RANGE] Applied: ${min} to ${max}, Limit: ${limit}`);
        }
      }

      // Fetch matching websites with optional record range
      let websites;
      if (useRecordRange) {
        // Use raw database query for record range to ensure proper limiting
        const offset = parseInt(recordRangeMin) - 1;
        websites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
          where: filters,
          orderBy: sortObj,
          limit: limit,
          offset: offset,
          populate: ['currentPublisherId', 'originalPublisherId']
        });
        console.log(`[EXPORT RECORD RANGE] Raw query: offset=${offset}, limit=${limit}, results=${websites.length}`);
      } else {
        // Fetch all matching websites
        websites = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
          filters,
          sort: sortObj,
          populate: {
            currentPublisherId: {
              fields: ['id', 'username', 'email']
            },
            originalPublisherId: {
              fields: ['id', 'username', 'email']
            }
          }
        });
      }

      console.log(`Found ${websites.length} websites to export`);

      if (websites.length === 0) {
        return ctx.badRequest('No websites found matching the criteria');
      }

      // Transform data for CSV export
      const csvData = websites.map(website => ({
        ID: website.id,
        Domain: website.url || 'N/A',
        Protocol: website.protocol || 'https',
        Title: website.publisherName || 'N/A',
        Description: website.description || 'No description',
        Status: website.submissionStatus || 'pending',
        Publisher_Email: website.publisherEmail || 'N/A',
        Publisher_Name: website.publisherName || 'N/A',
        Publisher_ID: website.currentPublisherId?.id || website.originalPublisherId?.id || 'N/A',
        Publisher_Username: website.currentPublisherId?.username || website.originalPublisherId?.username || 'Unknown',
        Publisher_Email_Current: website.currentPublisherId?.email || website.originalPublisherId?.email || 'N/A',
        
        // SEO Metrics
        DA: website.moz_da || 'N/A',
        DR: website.ahrefs_dr || 'N/A',
        Ahrefs_Rank: website.ahrefs_rank || 'N/A',
        Ahrefs_Traffic: website.ahrefs_traffic || 'N/A',
        Ahrefs_Keywords: website.ahrefs_keywords || 'N/A',
        Ahrefs_Referring_Domains: website.ahrefs_referring_domain || 'N/A',
        Semrush_Authority_Score: website.semrush_authority_score || 'N/A',
        Semrush_Traffic: website.semrush_traffic || 'N/A',
        Moz_Spam_Score: website.moz_spam_score || 'N/A',
        
        // Pricing
        General_Guest_Post_Price: website.generalGuestPostPrice || 0,
        General_Link_Insertion_Price: website.generalLinkInsertionPrice || 0,
        Casino_Accepted: website.casinoAccepted ? 'Yes' : 'No',
        Casino_Guest_Post_Price: website.casinoGuestPostPrice || 0,
        Casino_Link_Insertion_Price: website.casinoLinkInsertionPrice || 0,
        Crypto_Accepted: website.cryptoAccepted ? 'Yes' : 'No',
        Crypto_Guest_Post_Price: website.cryptoGuestPostPrice || 0,
        Crypto_Link_Insertion_Price: website.cryptoLinkInsertionPrice || 0,
        CBD_Accepted: website.cbdAccepted ? 'Yes' : 'No',
        CBD_Guest_Post_Price: website.cbdGuestPostPrice || 0,
        CBD_Link_Insertion_Price: website.cbdLinkInsertionPrice || 0,
        Dating_Accepted: website.datingAccepted ? 'Yes' : 'No',
        Dating_Guest_Post_Price: website.datingGuestPostPrice || 0,
        Dating_Link_Insertion_Price: website.datingLinkInsertionPrice || 0,
        Copywriting_Offered: website.doCopywriting ? 'Yes' : 'No',
        Copywriting_Price: website.copywritingPrice || 0,
        
        // Content Requirements
        Min_Word_Count: website.minWordCount || 500,
        Backlink_Type: website.backlinkType || 'Do follow',
        Allowed_Links: website.allowedLinks || 1,
        Backlink_Validity: website.backlinkValidity || 'one_year',
        Sponsored_Content: website.sponsored ? 'Yes' : 'No',
        UGC_Content: website.ugc ? 'Yes' : 'No',
        PR_Site: website.isPRSite ? 'Yes' : 'No',
        
        // Categories and Targeting
        Categories: Array.isArray(website.category) ? website.category.join(', ') : website.category || 'General',
        Countries: Array.isArray(website.countries) ? website.countries.join(', ') : website.countries || 'United States',
        Languages: Array.isArray(website.language) ? website.language.join(', ') : website.language || 'English',
        
        // Verification
        GSC_Verified: website.gscVerified ? 'Yes' : 'No',
        GSC_Verified_At: website.gscVerifiedAt || 'N/A',
        GSC_Permission_Level: website.gscPermissionLevel || 'N/A',
        Verification_Method: website.verificationMethod || 'N/A',
        
        // Delivery
        Expected_TAT_Hours: website.expectedTATHours || 168,
        Sample_Posts: Array.isArray(website.samplePosts) ? website.samplePosts.join('; ') : website.samplePosts || 'N/A',
        Guidelines: website.guidelines || 'N/A',
        
        // Additional Metadata
        Reseller_Code: website.resellerCode || 'N/A',
        Added_By_Reseller: website.addedByReseller ? 'Yes' : 'No',
        Metrics_Last_Updated: website.metrics_last_updated || 'Never',
        Metrics_Update_Count: website.metrics_update_count || 0,
        Metrics_Update_Method: website.metrics_update_method || 'N/A',
        
        // Dates
        Created_At: website.createdAt,
        Updated_At: website.updatedAt,
        Approved_At: website.approvedAt || 'N/A',
        Reviewed_At: website.reviewedAt || 'N/A',
        Ownership_Transferred_At: website.ownershipTransferredAt || 'N/A'
      }));

      // Convert to CSV
      const csvHeaders = Object.keys(csvData[0]);
      const csvRows = csvData.map(row => csvHeaders.map(header => row[header]));
      const csvContent = [csvHeaders, ...csvRows]
        .map(row => row.map(cell => `"${cell}"`).join(','))
        .join('\n');

      // Set response headers for CSV download
      ctx.type = 'text/csv';
      ctx.attachment(`websites_export_${new Date().toISOString().split('T')[0]}.csv`);
      
      // Send as buffer to ensure proper blob handling
      const buffer = Buffer.from(csvContent, 'utf8');
      return ctx.send(buffer);
    } catch (error) {
      console.error('Error in exportFiltered:', error);
      return ctx.badRequest(`Error exporting data: ${error.message}`);
    }
  },

  /**
   * Delete website
   */
  async delete(ctx) {
    try {
      const { id } = ctx.params;

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} deleting website ${id}`);

      // Check if website exists
      const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      if (!website) {
        return ctx.notFound('Website not found');
      }

      // CASCADE DELETE: Also delete from marketplace if it exists
      if (website.url) {
        try {
          console.log(`[ADMIN ACTION] Checking for marketplace entry with URL: ${website.url}`);
          
          // Find marketplace entry with the same URL
          const marketplaceEntry = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { url: website.url }
          });

          if (marketplaceEntry) {
            console.log(`[ADMIN ACTION] Found marketplace entry ${marketplaceEntry.id} for URL ${website.url}, deleting it`);
            
            // Delete the marketplace entry
            await strapi.entityService.delete('api::marketplace.marketplace', marketplaceEntry.id);
            
            console.log(`[ADMIN ACTION] Successfully deleted marketplace entry ${marketplaceEntry.id} for URL ${website.url}`);
          } else {
            console.log(`[ADMIN ACTION] No marketplace entry found for URL ${website.url}`);
          }
        } catch (marketplaceError) {
          console.error(`[ADMIN ACTION] Error deleting marketplace entry for URL ${website.url}:`, marketplaceError);
          // Don't fail the website deletion if marketplace deletion fails
        }
      }

      // Delete the website
      await strapi.entityService.delete('api::publisher-website.publisher-website', id);

      console.log(`[ADMIN ACTION] Successfully deleted website ${id}`);

      ctx.send({
        message: 'Website deleted successfully'
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE DELETE ERROR]', error);
      return ctx.internalServerError('Failed to delete website');
    }
  },

  /**
   * Bulk approve websites
   */
  async bulkApprove(ctx) {
    try {
      const { websiteIds } = ctx.request.body;

      if (!websiteIds || !Array.isArray(websiteIds) || websiteIds.length === 0) {
        return ctx.badRequest('Website IDs are required');
      }

      console.log(`[ADMIN BULK ACTION] Admin ${ctx.state.user.id} bulk approving ${websiteIds.length} websites`);

      const results = [];
      const errors = [];

      for (const id of websiteIds) {
        try {
          // Check if website exists and has required metrics
          const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
          
          if (!website) {
            errors.push({ id, error: `Website with ID ${id} not found` });
            continue;
          }

          // Policy validation: Check if website has metrics
          if (!website.moz_da && !website.ahrefsDR) {
            errors.push({ 
              id, 
              error: `Website "${website.url}" does not have required metrics (DA/DR). Please update metrics first.` 
            });
            continue;
          }

          // Approve the website
          const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
            data: { 
              submissionStatus: 'approved',
              approvedAt: new Date(),
              approvedBy: ctx.state.user.id
            }
          });

          results.push({ id, status: 'approved' });

          // Add to marketplace if not already there
          if (updatedWebsite.url) {
            try {
              const existingMarketplaceRecord = await strapi.entityService.findMany('api::marketplace.marketplace', {
                filters: { url: updatedWebsite.url },
                limit: 1
              });

              if (!existingMarketplaceRecord || existingMarketplaceRecord.length === 0) {
                await strapi.entityService.create('api::marketplace.marketplace', {
                  data: {
                    url: updatedWebsite.url,
                    status: 'active',
                    publisherWebsite: updatedWebsite.id,
                    createdAt: new Date(),
                    updatedAt: new Date()
                  }
                });
              }
            } catch (marketplaceError) {
              console.error(`Error adding website ${updatedWebsite.url} to marketplace:`, marketplaceError);
            }
          }

        } catch (error) {
          console.error(`Error approving website ${id}:`, error);
          errors.push({ id, error: `Failed to approve website: ${error.message}` });
        }
      }

      console.log(`[ADMIN BULK ACTION] Bulk approval completed: ${results.length} successful, ${errors.length} failed`);

      ctx.send({
        message: `Bulk approval completed: ${results.length} successful, ${errors.length} failed`,
        results,
        errors
      });

    } catch (error) {
      console.error('[ADMIN BULK APPROVE ERROR]', error);
      return ctx.internalServerError('Failed to bulk approve websites');
    }
  },

  /**
   * Bulk reject websites
   */
  async bulkReject(ctx) {
    try {
      const { websiteIds, reason } = ctx.request.body;

      if (!websiteIds || !Array.isArray(websiteIds) || websiteIds.length === 0) {
        return ctx.badRequest('Website IDs are required');
      }

      if (!reason || reason.trim() === '') {
        return ctx.badRequest('Rejection reason is required');
      }

      console.log(`[ADMIN BULK ACTION] Admin ${ctx.state.user.id} bulk rejecting ${websiteIds.length} websites`);

      const results = [];
      const errors = [];

      for (const id of websiteIds) {
        try {
          // Check if website exists
          const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
          
          if (!website) {
            errors.push({ id, error: `Website with ID ${id} not found` });
            continue;
          }

          // Reject the website
          await strapi.entityService.update('api::publisher-website.publisher-website', id, {
            data: { 
              submissionStatus: 'rejected',
              rejectionReason: reason.trim(),
              rejectedAt: new Date(),
              rejectedBy: ctx.state.user.id
            }
          });

          results.push({ id, status: 'rejected' });

        } catch (error) {
          console.error(`Error rejecting website ${id}:`, error);
          errors.push({ id, error: `Failed to reject website: ${error.message}` });
        }
      }

      console.log(`[ADMIN BULK ACTION] Bulk rejection completed: ${results.length} successful, ${errors.length} failed`);

      ctx.send({
        message: `Bulk rejection completed: ${results.length} successful, ${errors.length} failed`,
        results,
        errors
      });

    } catch (error) {
      console.error('[ADMIN BULK REJECT ERROR]', error);
      return ctx.internalServerError('Failed to bulk reject websites');
    }
  },

  /**
   * Bulk delete websites
   */
  async bulkDelete(ctx) {
    try {
      const { websiteIds } = ctx.request.body;

      if (!websiteIds || !Array.isArray(websiteIds) || websiteIds.length === 0) {
        return ctx.badRequest('Website IDs are required');
      }

      console.log(`[ADMIN BULK ACTION] Admin ${ctx.state.user.id} bulk deleting ${websiteIds.length} websites`);

      const results = [];
      const errors = [];

      for (const id of websiteIds) {
        try {
          // Check if website exists
          const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
          
          if (!website) {
            errors.push({ id, error: `Website with ID ${id} not found` });
            continue;
          }

          // CASCADE DELETE: Also delete from marketplace if it exists
          if (website.url) {
            try {
              console.log(`[ADMIN BULK ACTION] Checking for marketplace entry with URL: ${website.url}`);
              
              // Find marketplace entry with the same URL
              const marketplaceEntry = await strapi.db.query('api::marketplace.marketplace').findOne({
                where: { url: website.url }
              });

              if (marketplaceEntry) {
                console.log(`[ADMIN BULK ACTION] Found marketplace entry ${marketplaceEntry.id} for URL ${website.url}, deleting it`);
                
                // Delete the marketplace entry
                await strapi.entityService.delete('api::marketplace.marketplace', marketplaceEntry.id);
                
                console.log(`[ADMIN BULK ACTION] Successfully deleted marketplace entry ${marketplaceEntry.id} for URL ${website.url}`);
              } else {
                console.log(`[ADMIN BULK ACTION] No marketplace entry found for URL ${website.url}`);
              }
            } catch (marketplaceError) {
              console.error(`[ADMIN BULK ACTION] Error deleting marketplace entry for URL ${website.url}:`, marketplaceError);
              // Don't fail the website deletion if marketplace deletion fails
            }
          }

          // Delete the website
          await strapi.entityService.delete('api::publisher-website.publisher-website', id);

          results.push({ id, status: 'deleted' });

        } catch (error) {
          console.error(`Error deleting website ${id}:`, error);
          errors.push({ id, error: `Failed to delete website: ${error.message}` });
        }
      }

      console.log(`[ADMIN BULK ACTION] Bulk deletion completed: ${results.length} successful, ${errors.length} failed`);

      ctx.send({
        message: `Bulk deletion completed: ${results.length} successful, ${errors.length} failed`,
        results,
        errors
      });

    } catch (error) {
      console.error('[ADMIN BULK DELETE ERROR]', error);
      return ctx.internalServerError('Failed to bulk delete websites');
    }
  }

}));
