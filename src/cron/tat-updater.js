'use strict';

/**
 * TAT Updater Cron Job
 * Automatically updates TAT (Turn Around Time) for websites based on completed orders
 */

module.exports = {
  // Run every day at 2 AM
  '0 2 * * *': async ({ strapi }) => {
    console.log('Starting daily TAT update cron job...');
    
    try {
      const marketplaceService = strapi.service('api::marketplace.marketplace');
      
      // Run bulk TAT update with conservative settings
      const result = await marketplaceService.bulkUpdateTAT({
        batchSize: 5,           // Process 5 websites at a time
        minOrderCount: 3,       // Require at least 3 completed orders
        lookbackDays: 90,       // Look back 90 days
        useWeightedAverage: true, // Use weighted average for more accurate TAT
        delayBetweenBatches: 2000 // 2 second delay between batches
      });
      
      console.log('Daily TAT update completed:', {
        totalProcessed: result.totalProcessed,
        updated: result.updated,
        errors: result.errors,
        unchanged: result.unchanged
      });
      
      // Log any errors for review
      if (result.errors > 0) {
        const errorDetails = result.details.filter(d => d.error);
        console.error('TAT update errors:', errorDetails);
      }
      
    } catch (error) {
      console.error('Failed to run daily TAT update:', error);
    }
  },

  // Run weekly deep analysis on Sundays at 3 AM
  '0 3 * * 0': async ({ strapi }) => {
    console.log('Starting weekly comprehensive TAT analysis...');
    
    try {
      const marketplaceService = strapi.service('api::marketplace.marketplace');
      
      // Run more comprehensive update with longer lookback
      const result = await marketplaceService.bulkUpdateTAT({
        batchSize: 3,           // Smaller batch size for deeper analysis
        minOrderCount: 2,       // Lower threshold for weekly analysis
        lookbackDays: 180,      // Look back 6 months
        useWeightedAverage: true,
        delayBetweenBatches: 3000 // 3 second delay for thoroughness
      });
      
      console.log('Weekly comprehensive TAT analysis completed:', {
        totalProcessed: result.totalProcessed,
        updated: result.updated,
        errors: result.errors,
        unchanged: result.unchanged
      });
      
      // Generate summary report
      const websitesWithSlowTAT = result.details.filter(d => 
        d.newTAT && d.newTAT > 14 // Websites with TAT > 14 days
      );
      
      const websitesWithFastTAT = result.details.filter(d => 
        d.newTAT && d.newTAT <= 3 // Websites with TAT <= 3 days
      );
      
      console.log('Weekly TAT Summary:', {
        slowWebsites: websitesWithSlowTAT.length,
        fastWebsites: websitesWithFastTAT.length,
        totalAnalyzed: result.details.length
      });
      
    } catch (error) {
      console.error('Failed to run weekly TAT analysis:', error);
    }
  }
}; 