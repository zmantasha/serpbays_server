#!/usr/bin/env node

/**
 * Manual TAT update script
 * 
 * Usage:
 * node scripts/manual-tat-update.js <websiteId>
 * 
 * Forces a TAT update for the specified website
 */

const strapi = require('@strapi/strapi');

async function manualTATUpdate() {
  try {
    console.log('🚀 Starting manual TAT update...');
    const app = await strapi().load();
    
    const websiteId = process.argv[2];
    
    if (!websiteId) {
      console.log('❌ Please provide a website ID: node scripts/manual-tat-update.js <websiteId>');
      process.exit(1);
    }
    
    console.log(`🎯 Updating TAT for website ID: ${websiteId}`);
    
    // Get current website info
    const website = await app.entityService.findOne('api::marketplace.marketplace', websiteId, {
      fields: ['url', 'tat', 'placement_speed']
    });
    
    if (!website) {
      console.error(`❌ Website with ID ${websiteId} not found`);
      process.exit(1);
    }
    
    console.log(`📊 Current state:`);
    console.log(`   URL: ${website.url}`);
    console.log(`   TAT: ${website.tat} days`);
    console.log(`   Placement Speed: ${website.placement_speed}`);
    
    // Force TAT update with minimal requirements
    const marketplaceService = app.service('api::marketplace.marketplace');
    const result = await marketplaceService.updateTATFromCompletedOrders(websiteId, {
      minOrderCount: 1,        // Accept even 1 completed order
      lookbackDays: 365,       // Look back 1 year
      useWeightedAverage: true
    });
    
    if (result) {
      console.log(`\n✅ TAT Update Results:`);
      console.log(`   Previous TAT: ${result.previousTAT || 'Unknown'} days`);
      console.log(`   New TAT: ${result.newTAT} days`);
      console.log(`   Placement Speed: ${result.placementSpeed}`);
      console.log(`   Orders analyzed: ${result.ordersAnalyzed}`);
      console.log(`   Individual TAT values: [${result.tatValues.join(', ')}] days`);
      
      // Verify the update worked
      const updatedWebsite = await app.entityService.findOne('api::marketplace.marketplace', websiteId, {
        fields: ['tat', 'placement_speed']
      });
      
      console.log(`\n🔍 Verification:`);
      console.log(`   Database TAT: ${updatedWebsite.tat} days`);
      console.log(`   Database Placement Speed: ${updatedWebsite.placement_speed}`);
      
      if (updatedWebsite.tat === result.newTAT && updatedWebsite.placement_speed === result.placementSpeed) {
        console.log(`   ✅ TAT successfully updated in database!`);
      } else {
        console.log(`   ❌ TAT update may not have been saved properly`);
      }
      
    } else {
      console.log(`\n❌ TAT Update Failed:`);
      console.log(`   Reason: Insufficient completed orders for this website`);
      
      // Check order count
      const orderCount = await app.db.query('api::order.order').count({
        where: {
          website: websiteId,
          orderStatus: 'completed',
          completedDate: { $notNull: true },
          orderDate: { $notNull: true }
        }
      });
      
      console.log(`   Completed orders with dates: ${orderCount}`);
      console.log(`   💡 Complete more orders to enable TAT calculation`);
    }
    
    console.log(`\n🎉 Manual TAT update completed!`);
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Manual TAT update failed:', error);
    process.exit(1);
  }
}

manualTATUpdate(); 