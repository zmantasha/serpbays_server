'use strict';

/**
 * Admin Websites Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::publisher-website.publisher-website', ({ strapi }) => ({

  /**
   * Get all websites with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const { 
        page = 1, 
        pageSize = 20, 
        sort = 'createdAt:desc',
        search = '',
        status = '',
        userId = ''
      } = ctx.query;

      // Build filters
      const filters = {};
      
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

      // Get websites with pagination
      const websites = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
        filters,
        sort,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize)
        },
        populate: {
          currentPublisherId: {
            fields: ['id', 'username', 'email']
          },
          originalPublisherId: {
            fields: ['id', 'username', 'email']
          }
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::publisher-website.publisher-website').count({ where: filters });

      // Debug: Check what's actually in the database
      const allWebsites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        populate: ['currentPublisherId', 'originalPublisherId']
      });
      
      console.log('[ADMIN WEBSITES DEBUG]', {
        total,
        websitesCount: websites.length,
        allWebsitesCount: allWebsites.length,
        allWebsites: allWebsites.map(w => ({
          id: w.id,
          url: w.url,
          submissionStatus: w.submissionStatus,
          publisherName: w.publisherName
        }))
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

      const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: { 
          submissionStatus: 'rejected',
          rejectionReason: reason,
          rejectedAt: new Date(),
          rejectedBy: ctx.state.user.id
        },
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
      console.error('[ADMIN WEBSITE REJECT ERROR]', error);
      return ctx.internalServerError('Failed to reject website');
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
      console.log('[ADMIN WEBSITE STATS] Method called with params:', ctx.params);
      console.log('[ADMIN WEBSITE STATS] Method called with query:', ctx.query);
      
      // Declare variables at function level
      let total, pending, approved, rejected;
      
      // Check if collection exists
      try {
        total = await strapi.db.query('api::publisher-website.publisher-website').count();
        console.log('[ADMIN WEBSITE STATS] Total count:', total);
        
        pending = await strapi.db.query('api::publisher-website.publisher-website').count({
          where: { submissionStatus: 'approval_pending' }
        });
        console.log('[ADMIN WEBSITE STATS] Pending count:', pending);
        
        approved = await strapi.db.query('api::publisher-website.publisher-website').count({
          where: { submissionStatus: 'approved' }
        });
        console.log('[ADMIN WEBSITE STATS] Approved count:', approved);
        
        rejected = await strapi.db.query('api::publisher-website.publisher-website').count({
          where: { submissionStatus: 'rejected' }
        });
        console.log('[ADMIN WEBSITE STATS] Rejected count:', rejected);
      } catch (dbError) {
        console.error('[ADMIN WEBSITE STATS] Database query error:', dbError);
        throw dbError;
      }
      
      // Debug: Check all statuses in database
      const allStatuses = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        fields: ['id', 'submissionStatus']
      });
      
      console.log('[ADMIN WEBSITE STATS DEBUG]', {
        total,
        pending,
        approved,
        rejected,
        allStatuses: allStatuses.map(w => ({ id: w.id, status: w.submissionStatus }))
      });

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
          const { id, ...metricsData } = websiteData;
          
          if (!id) {
            errors.push({ id: 'unknown', error: 'Missing website ID' });
            continue;
          }
          console.log("id",id)

          // Add metrics update tracking
          const updateData = {
            ...metricsData,
            metrics_last_updated: new Date(),
            metrics_update_count: (metricsData.metrics_update_count || 0) + 1,
            metrics_update_method: 'bulk_import'
          };
          console.log("update", updateData)

          const updatedWebsite = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
            data: updateData
          });
          console.log("updateedWebsite",updatedWebsite)

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
          errors.push({ 
            id: websiteData.id || 'unknown', 
            error: error.message 
          });
        }
      }

     return ctx.send({
        success: true,
        updated: results.length,
        errors: errors.length,
        results,
        errors
      });

    } catch (error) {
      console.error('[ADMIN WEBSITE BULK UPDATE METRICS ERROR]', error);
      return ctx.internalServerError('Failed to perform bulk metrics update');
    }
  }

}));
