'use strict';

/**
 * marketplace service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::marketplace.marketplace', ({ strapi }) => ({
  
  /**
   * Calculate and update TAT based on completed orders
   * @param {number} websiteId - The marketplace website ID
   * @param {object} options - Calculation options
   * @returns {Promise<object>} - Updated TAT and placement speed
   */
  async updateTATFromCompletedOrders(websiteId, options = {}) {
    try {
      const {
        lookbackDays = 90,    // Look back 90 days for order history
        minOrderCount = 3,    // Minimum orders needed for reliable calculation
        useWeightedAverage = true  // Use weighted average (more recent orders have higher weight)
      } = options;

      // Get completed orders for this website in the lookback period
      const completedOrders = await strapi.db.query('api::order.order').findMany({
        where: {
          website: websiteId,
          orderStatus: 'completed',
          completedDate: {
            $gte: new Date(Date.now() - (lookbackDays * 24 * 60 * 60 * 1000))
          },
          orderDate: {
            $notNull: true
          }
        },
        orderBy: { completedDate: 'desc' },
        limit: 50 // Limit to last 50 orders for performance
      });

      if (completedOrders.length < minOrderCount) {
        console.log(`Not enough completed orders (${completedOrders.length}) for website ${websiteId}. Minimum required: ${minOrderCount}`);
        return null;
      }

      // Calculate TAT for each completed order
      const tatValues = completedOrders.map((order, index) => {
        const orderDate = new Date(order.orderDate);
        const completedDate = new Date(order.completedDate);
        const tatDays = Math.ceil((completedDate - orderDate) / (1000 * 60 * 60 * 24));
        
        // For weighted average, more recent orders get higher weight
        const weight = useWeightedAverage ? Math.pow(0.9, index) : 1;
        
        return {
          tat: Math.max(0, tatDays), // Ensure non-negative TAT
          weight: weight,
          orderDate: orderDate,
          completedDate: completedDate
        };
      });

      // Calculate weighted average TAT
      let totalWeightedTAT = 0;
      let totalWeight = 0;
      
      tatValues.forEach(item => {
        totalWeightedTAT += item.tat * item.weight;
        totalWeight += item.weight;
      });

      const averageTAT = Math.round(totalWeightedTAT / totalWeight);

      // Calculate placement speed based on new TAT
      const placementSpeed = this.calculatePlacementSpeed(averageTAT);

      // Update the marketplace entry
      const updatedWebsite = await strapi.entityService.update('api::marketplace.marketplace', websiteId, {
        data: {
          tat: averageTAT,
          placement_speed: placementSpeed
        }
      });

      console.log(`Updated TAT for website ${websiteId}: ${averageTAT} days (${placementSpeed}) based on ${completedOrders.length} orders`);

      return {
        previousTAT: updatedWebsite.tat,
        newTAT: averageTAT,
        placementSpeed: placementSpeed,
        ordersAnalyzed: completedOrders.length,
        tatValues: tatValues.map(v => v.tat)
      };

    } catch (error) {
      console.error(`Error updating TAT for website ${websiteId}:`, error);
      throw error;
    }
  },

  /**
   * Calculate placement speed based on TAT
   * @param {number} tat - Turn around time in days
   * @returns {string} - Placement speed category
   */
  calculatePlacementSpeed(tat) {
    if (!tat || tat < 0) return 'Normal';
    
    if (tat >= 0 && tat <= 2) return 'Ultra Fast';
    if (tat >= 3 && tat <= 5) return 'Fast';
    if (tat >= 6 && tat <= 8) return 'Normal';
    if (tat >= 9 && tat <= 20) return 'Slow';
    
    // For TAT > 20 days, consider it Slow
    return 'Slow';
  },

  /**
   * Bulk update TAT for all websites with sufficient order history
   * @param {object} options - Update options
   * @returns {Promise<object>} - Summary of updates
   */
  async bulkUpdateTAT(options = {}) {
    try {
      const {
        batchSize = 10,
        minOrderCount = 3,
        delayBetweenBatches = 1000 // 1 second delay between batches
      } = options;

      // Get all websites that have orders
      const websites = await strapi.db.query('api::marketplace.marketplace').findMany({
        select: ['id', 'url', 'tat'],
        populate: {
          orders: {
            select: ['id'],
            where: {
              orderStatus: 'completed'
            }
          }
        }
      });

      // Filter websites with sufficient order history
      const websitesWithOrders = websites.filter(website => 
        website.orders && website.orders.length >= minOrderCount
      );

      console.log(`Found ${websitesWithOrders.length} websites with sufficient order history for TAT update`);

      const results = {
        totalProcessed: 0,
        updated: 0,
        errors: 0,
        unchanged: 0,
        details: []
      };

      // Process in batches to avoid overwhelming the system
      for (let i = 0; i < websitesWithOrders.length; i += batchSize) {
        const batch = websitesWithOrders.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (website) => {
          try {
            const updateResult = await this.updateTATFromCompletedOrders(website.id, options);
            results.totalProcessed++;
            
            if (updateResult) {
              results.updated++;
              results.details.push({
                websiteId: website.id,
                url: website.url,
                ...updateResult
              });
            } else {
              results.unchanged++;
            }
          } catch (error) {
            results.errors++;
            results.details.push({
              websiteId: website.id,
              url: website.url,
              error: error.message
            });
          }
        });

        await Promise.all(batchPromises);
        
        // Add delay between batches
        if (i + batchSize < websitesWithOrders.length) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }
      }

      console.log(`TAT bulk update completed: ${results.updated} updated, ${results.errors} errors, ${results.unchanged} unchanged`);
      
      return results;
    } catch (error) {
      console.error('Error in bulk TAT update:', error);
      throw error;
    }
  }
}));
