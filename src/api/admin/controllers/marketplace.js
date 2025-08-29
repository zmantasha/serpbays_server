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
      const { page = 1, pageSize = 20, search, categoryFilter, statusFilter } = ctx.query;

      // Build filters
      const filters = {};
      
      if (search) {
        filters.$or = [
          { url: { $containsi: search } },
          { publisher_name: { $containsi: search } },
          { publisher_email: { $containsi: search } }
        ];
      }

      if (categoryFilter) {
        filters.category = categoryFilter;
      }

      if (statusFilter) {
        filters.status = statusFilter;
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

        return {
          id: website.id,
          domain: website.url,
          title: website.publisher_name || website.url,
          category: website.category,
          subcategory: website.subcategory,
          metrics: {
            da: website.moz_da,
            dr: website.ahrefs_dr,
            traffic: website.ahrefs_traffic,
            backlinks: website.ahrefs_rank,
            organicKeywords: website.semrush_authority_score,
            pageSpeed: website.placement_speed,
            mobileFriendly: website.fast_placement_status,
            ssl: true // Default to true since there's no SSL field in schema
          },
          content: {
            language: 'English', // Default since not in schema
            country: 'United States', // Default since not in schema
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
        subcategory: website.subcategory,
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
          language: 'English', // Default since not in schema
          country: 'United States', // Default since not in schema
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
              where: { url: domain }
            });

            if (existing) {
              if (replaceExisting) {
                // Update existing website
                await strapi.entityService.update('api::marketplace.marketplace', existing.id, {
                  data: {
                    publisher_name: title,
                    category,
                    moz_da: da,
                    ahrefs_traffic: traffic,
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
              url: domain,
              publisher_name: title,
              category,
              moz_da: da,
              ahrefs_traffic: traffic,
              price,
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
