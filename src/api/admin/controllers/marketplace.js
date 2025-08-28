'use strict';

/**
 * Admin Marketplace Management Controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::marketplace.marketplace', ({ strapi }) => ({

  /**
   * Get all marketplace websites with pagination and filters for admin panel
   */
  async find(ctx) {
    try {
      const { 
        page = 1, 
        pageSize = 20, 
        sort = 'createdAt:desc',
        search = '',
        category = '',
        status = ''
      } = ctx.query;

      // Build filters
      const filters = {};
      
      // Search filter
      if (search) {
        filters.$or = [
          { domain: { $containsi: search } },
          { title: { $containsi: search } },
          { description: { $containsi: search } }
        ];
      }

      // Category filter
      if (category) {
        filters.category = category;
      }

      // Status filter (using publishedAt as status indicator)
      if (status === 'active') {
        filters.publishedAt = { $notNull: true };
      } else if (status === 'inactive') {
        filters.publishedAt = { $null: true };
      }

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

      // Transform data for admin panel
      const transformedWebsites = websites.map(website => ({
        id: website.id,
        domain: website.domain,
        title: website.title || website.domain,
        category: website.category,
        subcategory: website.subcategory,
        metrics: {
          da: website.domainAuthority,
          dr: website.domainRating,
          traffic: website.monthlyTraffic,
          backlinks: website.backlinks,
          organicKeywords: website.organicKeywords,
          pageSpeed: website.pageSpeed,
          mobileFriendly: website.mobileFriendly,
          ssl: website.sslCertificate
        },
        content: {
          language: website.language,
          country: website.country,
          updateFrequency: website.contentUpdateFrequency,
          contentType: website.contentType,
          topics: website.topics ? website.topics.split(',').map(t => t.trim()) : []
        },
        financial: {
          price: parseFloat(website.price || 0),
          currency: website.currency || 'USD',
          commission: parseFloat(website.commission || 0),
          netAmount: parseFloat(website.price || 0) - parseFloat(website.commission || 0)
        },
        status: website.publishedAt ? 'Active' : 'Inactive',
        approvalDate: website.publishedAt,
        lastUpdated: website.updatedAt,
        createdAt: website.createdAt
      }));

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

      // Transform data for admin panel
      const transformedWebsite = {
        id: website.id,
        domain: website.domain,
        title: website.title || website.domain,
        description: website.description,
        category: website.category,
        subcategory: website.subcategory,
        metrics: {
          da: website.domainAuthority,
          dr: website.domainRating,
          traffic: website.monthlyTraffic,
          backlinks: website.backlinks,
          organicKeywords: website.organicKeywords,
          pageSpeed: website.pageSpeed,
          mobileFriendly: website.mobileFriendly,
          ssl: website.sslCertificate,
          socialMedia: {
            twitter: website.twitterHandle,
            linkedin: website.linkedinProfile,
            facebook: website.facebookPage
          }
        },
        content: {
          language: website.language,
          country: website.country,
          updateFrequency: website.contentUpdateFrequency,
          contentType: website.contentType,
          topics: website.topics ? website.topics.split(',').map(t => t.trim()) : [],
          targetAudience: website.targetAudience
        },
        financial: {
          price: parseFloat(website.price || 0),
          currency: website.currency || 'USD',
          commission: parseFloat(website.commission || 0),
          netAmount: parseFloat(website.price || 0) - parseFloat(website.commission || 0)
        },
        contact: {
          email: website.contactEmail,
          phone: website.contactPhone,
          website: website.contactWebsite
        },
        status: website.publishedAt ? 'Active' : 'Inactive',
        approvalDate: website.publishedAt,
        lastUpdated: website.updatedAt,
        createdAt: website.createdAt,
        tat: website.tat || 'Not specified'
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
      
      if (updateData.title) strapiData.title = updateData.title;
      if (updateData.description) strapiData.description = updateData.description;
      if (updateData.category) strapiData.category = updateData.category;
      if (updateData.subcategory) strapiData.subcategory = updateData.subcategory;
      
      if (updateData.metrics) {
        if (updateData.metrics.da) strapiData.domainAuthority = updateData.metrics.da;
        if (updateData.metrics.dr) strapiData.domainRating = updateData.metrics.dr;
        if (updateData.metrics.traffic) strapiData.monthlyTraffic = updateData.metrics.traffic;
        if (updateData.metrics.backlinks) strapiData.backlinks = updateData.metrics.backlinks;
        if (updateData.metrics.organicKeywords) strapiData.organicKeywords = updateData.metrics.organicKeywords;
        if (updateData.metrics.pageSpeed) strapiData.pageSpeed = updateData.metrics.pageSpeed;
        if (updateData.metrics.mobileFriendly !== undefined) strapiData.mobileFriendly = updateData.metrics.mobileFriendly;
        if (updateData.metrics.ssl !== undefined) strapiData.sslCertificate = updateData.metrics.ssl;
      }
      
      if (updateData.content) {
        if (updateData.content.language) strapiData.language = updateData.content.language;
        if (updateData.content.country) strapiData.country = updateData.content.country;
        if (updateData.content.updateFrequency) strapiData.contentUpdateFrequency = updateData.content.updateFrequency;
        if (updateData.content.contentType) strapiData.contentType = updateData.content.contentType;
        if (updateData.content.topics) strapiData.topics = updateData.content.topics.join(', ');
        if (updateData.content.targetAudience) strapiData.targetAudience = updateData.content.targetAudience;
      }
      
      if (updateData.financial) {
        if (updateData.financial.price) strapiData.price = updateData.financial.price;
        if (updateData.financial.currency) strapiData.currency = updateData.financial.currency;
        if (updateData.financial.commission) strapiData.commission = updateData.financial.commission;
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
        select: ['domainAuthority', 'domainRating', 'price']
      });
      
      const avgDA = metricsData.reduce((sum, w) => sum + (parseFloat(w.domainAuthority) || 0), 0) / metricsData.length || 0;
      const avgDR = metricsData.reduce((sum, w) => sum + (parseFloat(w.domainRating) || 0), 0) / metricsData.length || 0;
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

      for (const websiteData of websites) {
        try {
          const { domain, title, category, da, traffic, price, status } = websiteData;

          if (!domain) {
            results.errors.push({ domain: 'N/A', error: 'Domain is required' });
            continue;
          }

          // Check for duplicates
          if (duplicateCheck) {
            const existing = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { domain }
            });

            if (existing) {
              if (replaceExisting) {
                // Update existing website
                await strapi.entityService.update('api::marketplace.marketplace', existing.id, {
                  data: {
                    title,
                    category,
                    domainAuthority: da,
                    monthlyTraffic: traffic,
                    price,
                    publishedAt: status === 'Active' ? new Date() : null
                  }
                });
                results.updated++;
              } else {
                results.skipped++;
              }
              continue;
            }
          }

          // Create new website
          await strapi.entityService.create('api::marketplace.marketplace', {
            data: {
              domain,
              title,
              category,
              domainAuthority: da,
              monthlyTraffic: traffic,
              price,
              currency: 'USD',
              publishedAt: status === 'Active' ? new Date() : null
            }
          });
          results.imported++;

        } catch (error) {
          results.errors.push({ 
            domain: websiteData.domain || 'N/A', 
            error: error.message 
          });
        }
      }

      console.log(`[ADMIN ACTION] Admin ${ctx.state.user.id} bulk imported ${results.imported} websites`);

      ctx.send({
        message: 'Bulk import completed',
        results
      });

    } catch (error) {
      console.error('[ADMIN MARKETPLACE BULK IMPORT ERROR]', error);
      return ctx.internalServerError('Failed to perform bulk import');
    }
  }

}));
