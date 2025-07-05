#!/usr/bin/env node

/**
 * Test script for TAT (Turn Around Time) update functionality
 * 
 * Usage:
 * node scripts/test-tat-update.js [websiteId]
 * 
 * If websiteId is provided, tests update for that specific website.
 * If no websiteId is provided, runs a bulk update test.
 */

const strapi = require('@strapi/strapi');

async function testTATUpdate() {
  try {
    // Initialize Strapi
    console.log('Initializing Strapi...');
    const app = await strapi().load();
    
    const websiteId = process.argv[2];
    const marketplaceService = app.service('api::marketplace.marketplace');
    
    if (websiteId) {
      // Test single website TAT update
      console.log(`\nTesting TAT update for website ID: ${websiteId}`);
      
      // Get website info
      const website = await app.entityService.findOne('api::marketplace.marketplace', websiteId, {
        fields: ['url', 'tat', 'placement_speed']
      });
      
      if (!website) {
        console.error(`Website with ID ${websiteId} not found`);
        process.exit(1);
      }
      
      console.log(`Website: ${website.url}`);
      console.log(`Current TAT: ${website.tat} days`);
      console.log(`Current Placement Speed: ${website.placement_speed}`);
      
      // Get order count for this website
      const orderCount = await app.db.query('api::order.order').count({
        where: {
          website: websiteId,
          orderStatus: 'completed',
          completedDate: {
            $notNull: true
          }
        }
      });
      
      console.log(`Completed orders found: ${orderCount}`);
      
      if (orderCount === 0) {
        console.log('No completed orders found for this website. Cannot calculate TAT.');
        process.exit(0);
      }
      
      // Update TAT
      console.log('\nUpdating TAT...');
      const result = await marketplaceService.updateTATFromCompletedOrders(websiteId, {
        minOrderCount: 1, // Lower threshold for testing
        lookbackDays: 365, // Look back 1 year
        useWeightedAverage: true
      });
      
      if (result) {
        console.log('\n✅ TAT Update Results:');
        console.log(`Previous TAT: ${result.previousTAT || 'Unknown'} days`);
        console.log(`New TAT: ${result.newTAT} days`);
        console.log(`Placement Speed: ${result.placementSpeed}`);
        console.log(`Orders analyzed: ${result.ordersAnalyzed}`);
        console.log(`TAT values: [${result.tatValues.join(', ')}] days`);
      } else {
        console.log('❌ Insufficient data to update TAT');
      }
      
    } else {
      // Test bulk TAT update
      console.log('\nTesting bulk TAT update...');
      
      const result = await marketplaceService.bulkUpdateTAT({
        batchSize: 3,
        minOrderCount: 1,
        lookbackDays: 365,
        useWeightedAverage: true,
        delayBetweenBatches: 500
      });
      
      console.log('\n✅ Bulk TAT Update Results:');
      console.log(`Total processed: ${result.totalProcessed}`);
      console.log(`Updated: ${result.updated}`);
      console.log(`Errors: ${result.errors}`);
      console.log(`Unchanged: ${result.unchanged}`);
      
      if (result.details.length > 0) {
        console.log('\nDetails:');
        result.details.forEach(detail => {
          if (detail.error) {
            console.log(`❌ ${detail.url}: ${detail.error}`);
          } else {
            console.log(`✅ ${detail.url}: ${detail.newTAT} days (${detail.placementSpeed})`);
          }
        });
      }
    }
    
    console.log('\n🎉 Test completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⚠️ Test interrupted');
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\n⚠️ Test terminated');
  process.exit(1);
});

// Run the test
testTATUpdate(); 