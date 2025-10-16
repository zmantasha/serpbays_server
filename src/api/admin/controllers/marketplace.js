'use strict';

/**
 * Admin Marketplace Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::marketplace.marketplace', ({ strapi }) => ({

  /**
   * Get marketplace websites with pagination and filtering
   */
  async find(ctx) {
    try {
      const { 
        page = 1, 
        pageSize = 20, 
        search, 
        category, 
        status,
        // Numerical range filters
        minDA, maxDA, minDR, maxDR,
        minAhrefsTraffic, maxAhrefsTraffic,
        minPrice, maxPrice,
        minSemrushTraffic, maxSemrushTraffic,
        minSimilarwebTraffic, maxSimilarwebTraffic,
        minSpamScore, maxSpamScore,
        // Additional filters
        sensitiveCategory, language, country,
        allowedLinks, placementSpeed, sponsored, ugc, backlinkType,
        websiteUrl, domainZone, contentType
      } = ctx.query;

      // Build filters
      const filters = {};
      
      // Search filter
      if (search) {
        filters.$or = [
          { url: { $containsi: search } },
          { publisher_name: { $containsi: search } },
          { publisher_email: { $containsi: search } }
        ];
      }

      // Basic filters
      if (category && category !== 'All categories') {
        filters.category = category;
      }

      if (status && status !== 'All Status') {
        filters.status = status;
      }

      // Numerical range filters
      if (minDA || maxDA) {
        filters.moz_da = {};
        if (minDA) filters.moz_da.$gte = parseInt(minDA);
        if (maxDA) filters.moz_da.$lte = parseInt(maxDA);
      }

      if (minDR || maxDR) {
        filters.ahrefs_dr = {};
        if (minDR) filters.ahrefs_dr.$gte = parseInt(minDR);
        if (maxDR) filters.ahrefs_dr.$lte = parseInt(maxDR);
      }

      if (minAhrefsTraffic || maxAhrefsTraffic) {
        filters.ahrefs_traffic = {};
        if (minAhrefsTraffic) filters.ahrefs_traffic.$gte = parseInt(minAhrefsTraffic);
        if (maxAhrefsTraffic) filters.ahrefs_traffic.$lte = parseInt(maxAhrefsTraffic);
      }

      if (minPrice || maxPrice) {
        filters.price = {};
        if (minPrice) filters.price.$gte = parseFloat(minPrice);
        if (maxPrice) filters.price.$lte = parseFloat(maxPrice);
      }

      if (minSemrushTraffic || maxSemrushTraffic) {
        filters.semrush_traffic = {};
        if (minSemrushTraffic) filters.semrush_traffic.$gte = parseInt(minSemrushTraffic);
        if (maxSemrushTraffic) filters.semrush_traffic.$lte = parseInt(maxSemrushTraffic);
      }

      if (minSimilarwebTraffic || maxSimilarwebTraffic) {
        filters.similarweb_traffic = {};
        if (minSimilarwebTraffic) filters.similarweb_traffic.$gte = parseInt(minSimilarwebTraffic);
        if (maxSimilarwebTraffic) filters.similarweb_traffic.$lte = parseInt(maxSimilarwebTraffic);
      }

      if (minSpamScore || maxSpamScore) {
        filters.spam_score = {};
        if (minSpamScore) filters.spam_score.$gte = parseInt(minSpamScore);
        if (maxSpamScore) filters.spam_score.$lte = parseInt(maxSpamScore);
      }

      // Additional filters
      if (sensitiveCategory && sensitiveCategory !== 'Any sensitive category') {
        filters.sensitive_category = sensitiveCategory;
      }

      if (language && language !== 'All languages') {
        filters.language = language;
      }

      if (country && country !== 'All countries') {
        filters.countries = country;
      }

      if (allowedLinks && allowedLinks !== 'Any') {
        filters.allowed_links = allowedLinks;
      }

      if (placementSpeed && placementSpeed !== 'Any') {
        filters.placement_speed = placementSpeed;
      }

      if (sponsored && sponsored !== 'Any') {
        filters.sponsored = sponsored;
      }

      if (ugc && ugc !== 'Any') {
        filters.ugc = ugc;
      }

      if (backlinkType && backlinkType !== 'Any') {
        filters.backlink_type = backlinkType;
      }

      if (websiteUrl) {
        filters.url = { $containsi: websiteUrl };
      }

      if (domainZone) {
        filters.url = { $containsi: domainZone };
      }

      if (contentType && contentType !== 'All') {
        filters.content_type = contentType;
      }

      // Sort options
      const sort = { createdAt: 'desc' };

      // Get marketplace websites with pagination
      const websites = await strapi.entityService.findMany('api::marketplace.marketplace', {
        filters,
        sort,
        pagination: {
          page: parseInt(page),
          pageSize: parseInt(pageSize)
        }
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::marketplace.marketplace').count({ where: filters });

      // Transform data for admin panel with real order counts
      const transformedWebsites = await Promise.all(websites.map(async (website) => {
        // Best-effort metrics hydration from publisher-website if marketplace metrics are missing
        let metricsSource = { ...website };
        if (
          (metricsSource.moz_da == null || metricsSource.moz_da === 0) ||
          (metricsSource.ahrefs_dr == null || metricsSource.ahrefs_dr === 0) ||
          (metricsSource.ahrefs_traffic == null || metricsSource.ahrefs_traffic === 0)
        ) {
          try {
            const publisherWebsite = await strapi.db.query('api::publisher-website.publisher-website').findOne({
              where: { url: website.url }
            });
            if (publisherWebsite) {
              metricsSource = {
                ...metricsSource,
                moz_da: metricsSource.moz_da ?? publisherWebsite.moz_da ?? 0,
                ahrefs_dr: metricsSource.ahrefs_dr ?? publisherWebsite.ahrefs_dr ?? 0,
                ahrefs_traffic: metricsSource.ahrefs_traffic ?? publisherWebsite.ahrefs_traffic ?? 0,
                ahrefs_rank: metricsSource.ahrefs_rank ?? publisherWebsite.ahrefs_rank ?? 0,
                semrush_authority_score: metricsSource.semrush_authority_score ?? publisherWebsite.semrush_authority_score ?? 0,
                semrush_traffic: metricsSource.semrush_traffic ?? publisherWebsite.semrush_traffic ?? 0,
                moz_spam_score: metricsSource.moz_spam_score ?? publisherWebsite.moz_spam_score ?? 0,
              };
            }
          } catch (e) {
            console.warn('[MARKETPLACE] Failed to hydrate metrics from publisher-website for', website.url, e.message);
          }
        }
        // Get orders for this website
        const orders = await strapi.db.query('api::order.order').findMany({
          where: { website: website.id }
        });
        
        // Calculate order counts for this website
        const totalOrders = orders.length;
        
        // Calculate last month orders
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);
        const lastMonthOrders = orders.filter(order => {
          const orderDate = new Date(order.createdAt);
          return orderDate >= lastMonth;
        }).length;

        console.log(`[DEBUG] Website ${website.id} (${website.url}): totalOrders=${totalOrders}, lastMonthOrders=${lastMonthOrders}`);

        const transformed = {
          id: website.id,
          domain: website.url,
          title: website.publisher_name || website.url,
          category: website.category,
          subcategory: website.other_category,
          metrics: {
            da: metricsSource.moz_da,
            dr: metricsSource.ahrefs_dr,
            traffic: metricsSource.ahrefs_traffic,
            backlinks: metricsSource.ahrefs_rank,
            organicKeywords: metricsSource.semrush_authority_score,
            pageSpeed: website.placement_speed,
            mobileFriendly: website.fast_placement_status,
            ssl: true // Default to true since there's no SSL field in schema
          },
          content: {
            language: website.language, // Default since not in schema
            country: website.countries, // Default since not in schema
            updateFrequency: website.placement_speed || 'Normal',
            contentType: 'Blog Articles', // Default since not in schema
            topics: [] // Default since not in schema
          },
          financial: {
            price: parseFloat(website.price || 0),
            currency: 'USD', // Default since not in schema
            commission: parseFloat(website.publisher_price || 0),
            netAmount: parseFloat(website.price || 0) - parseFloat(website.publisher_price || 0)
          },
          publisher: {
            name: website.publisher_name || 'Unknown Publisher',
            email: website.publisher_email || 'N/A',
            phone: '', // Default since not in schema
            rating: 4.5, // Default rating since not in schema
            completedOrders: totalOrders, // Real order count
            joinDate: website.createdAt,
            specialization: 'General' // Default since not in schema
          },
          performance: {
            lastMonthOrders: lastMonthOrders, // Real last month orders
            totalOrders: totalOrders, // Real total orders
            averageRating: 4.5, // Default since not in schema
            completionRate: 100, // Default since not in schema
            responseTime: '24h', // Default since not in schema
            revenue: 0 // Default since not in schema
          },
          status: website.publishedAt ? 'Active' : 'Inactive',
          approvalDate: website.publishedAt,
          lastUpdated: website.updatedAt,
          createdAt: website.createdAt
        };

        console.log(`[DEBUG] Transformed website:`, transformed);
        return transformed;
      }));

      // Return the transformed data in the expected format
      return {
        data: transformedWebsites,
        meta: {
          pagination: {
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount: Math.ceil(total / pageSize),
            total
          }
        }
      };

    } catch (error) {
      console.error('[ADMIN MARKETPLACE FIND ERROR]', error);
      return ctx.internalServerError('Failed to fetch marketplace websites');
    }
  },

  /**
   * Get single marketplace website with full details
   */
  async findOne(ctx) {
    try {
      const { id } = ctx.params;

      const website = await strapi.entityService.findOne('api::marketplace.marketplace', id);

      if (!website) {
        return ctx.notFound('Marketplace website not found');
      }

      // Get orders for this website
      const orders = await strapi.db.query('api::order.order').findMany({
        where: { website: website.id }
      });
      
      // Calculate order counts for this website
      const totalOrders = orders.length;
      
      // Calculate last month orders
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      const lastMonthOrders = orders.filter(order => {
        const orderDate = new Date(order.createdAt);
        return orderDate >= lastMonth;
      }).length;

      console.log(`[DEBUG] Website ${website.id} (${website.url}): totalOrders=${totalOrders}, lastMonthOrders=${lastMonthOrders}`);

      // Transform data for admin panel
      const transformedWebsite = {
        id: website.id,
        domain: website.url,
        title: website.publisher_name || website.url,
        description: website.description,
        category: website.category,
        subcategory: website.other_category,
        metrics: {
          da: website.moz_da,
          dr: website.ahrefs_dr,
          traffic: website.ahrefs_traffic,
          backlinks: website.ahrefs_rank,
          organicKeywords: website.semrush_authority_score,
          pageSpeed: website.placement_speed,
          mobileFriendly: website.fast_placement_status,
          ssl: true, // Default to true since there's no SSL field in schema
          socialMedia: {
            twitter: website.twitterHandle,
            linkedin: website.linkedinProfile,
            facebook: website.facebookPage
          }
        },
        content: {
          language: website.language, // Default since not in schema
          country: website.country, // Default since not in schema
          updateFrequency: website.placement_speed || 'Normal',
          contentType: 'Blog Articles', // Default since not in schema
          topics: [], // Default since not in schema
          targetAudience: 'General' // Default since not in schema
        },
        publisher: {
          name: website.publisher_name || 'Unknown Publisher',
          email: website.publisher_email || 'N/A',
          phone: '', // Default since not in schema
          rating: 4.5, // Default rating since not in schema
          completedOrders: totalOrders, // Real order count
          joinDate: website.createdAt,
          specialization: 'General' // Default since not in schema
        },
        performance: {
          lastMonthOrders: lastMonthOrders, // Real last month orders
          totalOrders: totalOrders, // Real total orders
          averageRating: 4.5, // Default since not in schema
          completionRate: 100, // Default since not in schema
          responseTime: '24h', // Default since not in schema
          revenue: 0 // Default since not in schema
        },
        financial: {
          price: parseFloat(website.price || 0),
          currency: 'USD', // Default since not in schema
          commission: parseFloat(website.publisher_price || 0),
          netAmount: parseFloat(website.price || 0) - parseFloat(website.publisher_price || 0)
        },
        contact: {
          email: website.publisher_email,
          phone: '', // Default since not in schema
          website: website.url
        },
        status: website.publishedAt ? 'Active' : 'Inactive',
        approvalDate: website.publishedAt,
        lastUpdated: website.updatedAt,
        createdAt: website.createdAt,
        tat: website.tat || 'Not specified',
        documents: [], // Default since not in schema
        notes: [] // Default since not in schema
      };

      ctx.send({
        data: transformedWebsite
      });

    } catch (error) {
      console.error('[ADMIN MARKETPLACE FIND ONE ERROR]', error);
      return ctx.internalServerError('Failed to fetch marketplace website details');
    }
  },

  /**
   * Get marketplace statistics for admin dashboard
   */
  async getStats(ctx) {
    try {
      const total = await strapi.db.query('api::marketplace.marketplace').count();
      const active = await strapi.db.query('api::marketplace.marketplace').count({
        where: { publishedAt: { $notNull: true } }
      });
      const inactive = await strapi.db.query('api::marketplace.marketplace').count({
        where: { publishedAt: { $null: true } }
      });

      // Get category breakdown
      const categories = await strapi.db.query('api::marketplace.marketplace').findMany({
        select: ['category']
      });
      
      const categoryBreakdown = {};
      categories.forEach(website => {
        const cat = website.category || 'Uncategorized';
        categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
      });

      // Calculate average metrics
      const metricsData = await strapi.db.query('api::marketplace.marketplace').findMany({
        select: ['moz_da', 'ahrefs_dr', 'price']
      });
      
      const avgDA = metricsData.reduce((sum, w) => sum + (parseFloat(w.moz_da) || 0), 0) / metricsData.length || 0;
      const avgDR = metricsData.reduce((sum, w) => sum + (parseFloat(w.ahrefs_dr) || 0), 0) / metricsData.length || 0;
      const avgPrice = metricsData.reduce((sum, w) => sum + (parseFloat(w.price) || 0), 0) / metricsData.length || 0;

      ctx.send({
        total,
        active,
        inactive,
        categoryBreakdown,
        averageMetrics: {
          domainAuthority: Math.round(avgDA * 10) / 10,
          domainRating: Math.round(avgDR * 10) / 10,
          price: Math.round(avgPrice * 100) / 100
        }
      });

    } catch (error) {
      console.error('[ADMIN MARKETPLACE STATS ERROR]', error);
      return ctx.internalServerError('Failed to fetch marketplace statistics');
    }
  },

  /**
   * Update marketplace website (admin action)
   */
  async update(ctx) {
    try {
      const { id } = ctx.params;
      const updateData = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} updating marketplace website ${id}`);

      // Transform admin panel data back to Strapi format
      const strapiData = {};
      
      if (updateData.title) strapiData.publisher_name = updateData.title;
      if (updateData.description) strapiData.description = updateData.description;
      if (updateData.category) strapiData.category = updateData.category;
      if (updateData.subcategory) strapiData.subcategory = updateData.subcategory;
      
      if (updateData.metrics) {
        if (updateData.metrics.da) strapiData.moz_da = updateData.metrics.da;
        if (updateData.metrics.dr) strapiData.ahrefs_dr = updateData.metrics.dr;
        if (updateData.metrics.traffic) strapiData.ahrefs_traffic = updateData.metrics.traffic;
        if (updateData.metrics.backlinks) strapiData.ahrefs_rank = updateData.metrics.backlinks;
        if (updateData.metrics.organicKeywords) strapiData.semrush_authority_score = updateData.metrics.organicKeywords;
        if (updateData.metrics.pageSpeed) strapiData.placement_speed = updateData.metrics.pageSpeed;
        if (updateData.metrics.mobileFriendly !== undefined) strapiData.fast_placement_status = updateData.metrics.mobileFriendly;
      }
      
      if (updateData.content) {
        if (updateData.content.updateFrequency) strapiData.placement_speed = updateData.content.updateFrequency;
      }
      
      if (updateData.financial) {
        if (updateData.financial.price) strapiData.price = updateData.financial.price;
        if (updateData.financial.commission) strapiData.publisher_price = updateData.financial.commission;
      }

      if (updateData.tat) strapiData.tat = updateData.tat;

      const updatedWebsite = await strapi.entityService.update('api::marketplace.marketplace', id, {
        data: strapiData
      });

      ctx.send({
        data: updatedWebsite
      });

    } catch (error) {
      console.error('[ADMIN MARKETPLACE UPDATE ERROR]', error);
      return ctx.internalServerError('Failed to update marketplace website');
    }
  },

  /**
   * Toggle website status (activate/deactivate)
   */
  async toggleStatus(ctx) {
    try {
      const { id } = ctx.params;
      const { active } = ctx.request.body;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} ${active ? 'activating' : 'deactivating'} marketplace website ${id}`);

      const updatedWebsite = await strapi.entityService.update('api::marketplace.marketplace', id, {
        data: {
          publishedAt: active ? new Date() : null
        }
      });

      ctx.send({
        data: updatedWebsite
      });

    } catch (error) {
      console.error('[ADMIN MARKETPLACE TOGGLE STATUS ERROR]', error);
      return ctx.internalServerError('Failed to toggle website status');
    }
  },

  /**
   * Delete marketplace website (admin action)
   */
  async delete(ctx) {
    try {
      const { id } = ctx.params;

      // Log admin action
      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} deleting marketplace website ${id}`);

      await strapi.entityService.delete('api::marketplace.marketplace', id);

      ctx.send({
        message: 'Marketplace website deleted successfully'
      });

    } catch (error) {
      console.error('[ADMIN MARKETPLACE DELETE ERROR]', error);
      return ctx.internalServerError('Failed to delete marketplace website');
    }
  },

  /**
   * Bulk import websites from CSV (admin action)
   */
  async bulkImport(ctx) {
    try {
      const { websites, duplicateCheck = true, replaceExisting = false } = ctx.request.body;

      if (!Array.isArray(websites) || websites.length === 0) {
        return ctx.badRequest('No websites data provided');
      }

      const results = {
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: []
      };

      // Helper to extract validation messages from Strapi error
      const extractErrorMessages = (err) => {
        const messages = [];
        if (!err) return ['Unknown error'];
        if (err?.message) messages.push(err.message);
        // Strapi v4 validation details
        const details = err?.details || err?.error?.details;
        if (details?.errors && Array.isArray(details.errors)) {
          for (const e of details.errors) {
            if (e?.message && e?.path) {
              messages.push(`${e.path.join('.')}: ${e.message}`);
            } else if (e?.message) {
              messages.push(e.message);
            }
          }
        }
        // Unique constraint or DB errors
        if (err?.code && err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          messages.push('Duplicate URL (url must be unique)');
        }
        return messages.length > 0 ? messages : ['Unexpected error'];
      };

      for (const websiteData of websites) {
        try {
          const { 
            domain, 
            title, 
            category, 
            da, 
            traffic, 
            price, 
            status,
            publisherName,
            publisherEmail,
            publisherPrice,
            backlinkType,
            backlinkValidity,
            minWordCount,
            linkInsertionPrice,
            otherCategory,
            guidelines,
            dofollowLink,
            samplePost,
            ahrefsDr,
            ahrefsTraffic,
            ahrefsRank,
            mozDa,
            fastPlacementStatus,
            tat,
            language,
            countries
          } = websiteData;

          if (!domain) {
            results.errors.push({ domain: 'N/A', error: 'Domain is required' });
            continue;
          }

          // Prepare data object with all available fields
          // Normalize booleans and numbers
          const toBoolean = (val) => {
            if (typeof val === 'boolean') return val;
            if (typeof val === 'number') return val === 1;
            if (typeof val === 'string') {
              const v = val.trim().toLowerCase();
              return v === '1' || v === 'true' || v === 'yes' || v === 'y';
            }
            return false;
          };

          const toInteger = (val, fallback = 0) => {
            const n = parseInt(val, 10);
            return Number.isNaN(n) ? fallback : n;
          };

          const normalizedBacklinkType = backlinkType || (toBoolean(dofollowLink) ? 'Do follow' : 'No follow');
          const normalizedDofollowLink = toBoolean(dofollowLink) ? 1 : 0;
          const normalizedFastPlacement = toBoolean(fastPlacementStatus);
          const normalizedTat = toInteger(tat, 0);
          
          // Helper to parse multiple values from CSV fields
          const parseMultipleValues = (value, defaultValue = []) => {
            if (!value) return defaultValue;
            if (Array.isArray(value)) return value;
            if (typeof value === 'string') {
              const trimmed = value.trim();
              if (trimmed.length === 0) return defaultValue;
              
              // Split by common delimiters: comma, semicolon, pipe, or newline
              // Also handle cases where there might be spaces around delimiters
              const values = trimmed.split(/[,;|\n]/)
                .map(v => v.trim())
                .filter(v => v.length > 0);
              
              console.log(`[DEBUG] Parsing "${trimmed}" -> [${values.join(', ')}]`);
              return values.length > 0 ? values : defaultValue;
            }
            return defaultValue;
          };
          
          // Use consistent parsing for all array fields
          const normalizedCategory = parseMultipleValues(category, ['Uncategorized']);
          const normalizedLanguage = parseMultipleValues(language, ['English']);
          const normalizedOtherCategory = parseMultipleValues(otherCategory, null);
          const normalizedCountries = parseMultipleValues(countries, ['United States']);

          const websiteUpdateData = {
            url: domain,
            publisher_name: (publisherName || title || '').toString(),
            publisher_email: (publisherEmail || '').toString(),
            publisher_price: toInteger(publisherPrice, 0),
            category: normalizedCategory,
            language: normalizedLanguage,
            countries: normalizedCountries,
            moz_da: toInteger(mozDa ?? da, 0),
            ahrefs_dr: toInteger(ahrefsDr, 0),
            ahrefs_traffic: toInteger(ahrefsTraffic ?? traffic, 0),
            ahrefs_rank: toInteger(ahrefsRank, 0),
            price: toInteger(price, 0),
            backlink_type: normalizedBacklinkType,
            backlink_validity: (backlinkValidity || 'lifetime').toString(),
            min_word_count: toInteger(minWordCount, 500),
            link_insertion_price: toInteger(linkInsertionPrice, 0),
            other_category: normalizedOtherCategory,
            guidelines: guidelines || null,
            dofollow_link: normalizedDofollowLink,
            sample_post: samplePost || null,
            fast_placement_status: normalizedFastPlacement,
            tat: normalizedTat,
            publishedAt: status === 'Active' ? new Date() : null
          };

          // Debug logging for multiple values
          console.log(`[DEBUG] Processing ${domain}:`, {
            originalCategory: category,
            normalizedCategory,
            originalLanguage: language,
            normalizedLanguage,
            originalCountries: countries,
            normalizedCountries,
            originalOtherCategory: otherCategory,
            normalizedOtherCategory
          });

          // Always check for existing records when updating or when duplicate check is enabled
          if (duplicateCheck || replaceExisting) {
            const existing = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { url: domain }
            });

            if (existing) {
              if (replaceExisting) {
                // Full update - replace all data with CSV values
                console.log(`[DEBUG] Full update for existing website ${domain} with ID ${existing.id}`);
                await strapi.entityService.update('api::marketplace.marketplace', existing.id, {
                  data: websiteUpdateData
                });
                results.updated++;
                console.log(`[DEBUG] Successfully updated website ${domain} with full CSV data`);
              } else {
                results.skipped++;
              }
              continue;
            } else {
              // Record doesn't exist - this should create a new one
              console.log(`[DEBUG] No existing record found for ${domain}, will create new website`);
            }
          }

          // Create new website
          await strapi.entityService.create('api::marketplace.marketplace', {
            data: websiteUpdateData
          });
          results.imported++;

        } catch (error) {
          results.errors.push({ 
            domain: websiteData.domain || 'N/A', 
            errors: extractErrorMessages(error) 
          });
        }
      }

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} bulk imported ${results.imported} websites, updated ${results.updated} websites, skipped ${results.skipped} websites`);

      ctx.send({ message: 'Bulk import completed', results });

    } catch (error) {
      console.error('[ADMIN MARKETPLACE BULK IMPORT ERROR]', error);
      return ctx.internalServerError('Failed to perform bulk import');
    }
  }
}));
