#!/usr/bin/env node

/**
 * Debug script for TAT (Turn Around Time) issues
 * 
 * Usage:
 * node scripts/debug-tat.js [websiteId]
 * 
 * This script will help diagnose why TAT is not updating after order completion
 */

const strapi = require('@strapi/strapi');

async function debugTAT() {
  try {
    // Initialize Strapi
    console.log('🔍 Initializing Strapi for TAT debugging...');
    const app = await strapi().load();
    
    const websiteId = process.argv[2];
    
    if (!websiteId) {
      console.log('❌ Please provide a website ID: node scripts/debug-tat.js <websiteId>');
      process.exit(1);
    }
    
    console.log(`\n🌐 Debugging TAT for website ID: ${websiteId}`);
    
    // 1. Get website information
    const website = await app.entityService.findOne('api::marketplace.marketplace', websiteId, {
      fields: ['url', 'tat', 'placement_speed', 'publisher_email']
    });
    
    if (!website) {
      console.error(`❌ Website with ID ${websiteId} not found`);
      process.exit(1);
    }
    
    console.log(`\n📊 Current Website Status:`);
    console.log(`   URL: ${website.url}`);
    console.log(`   TAT: ${website.tat} days`);
    console.log(`   Placement Speed: ${website.placement_speed}`);
    console.log(`   Publisher: ${website.publisher_email}`);
    
    // 2. Get all orders for this website
    const allOrders = await app.db.query('api::order.order').findMany({
      where: { website: websiteId },
      orderBy: { createdAt: 'desc' },
      populate: ['advertiser', 'publisher']
    });
    
    console.log(`\n📦 Order Summary:`);
    console.log(`   Total orders: ${allOrders.length}`);
    
    // Group orders by status
    const ordersByStatus = {};
    allOrders.forEach(order => {
      ordersByStatus[order.orderStatus] = (ordersByStatus[order.orderStatus] || 0) + 1;
    });
    
    Object.entries(ordersByStatus).forEach(([status, count]) => {
      console.log(`   ${status}: ${count}`);
    });
    
    // 3. Get completed orders specifically
    const completedOrders = allOrders.filter(order => 
      order.orderStatus === 'completed' && 
      order.orderDate && 
      order.completedDate
    );
    
    console.log(`\n✅ Completed Orders Analysis:`);
    console.log(`   Completed orders with dates: ${completedOrders.length}`);
    
    if (completedOrders.length === 0) {
      console.log(`   ⚠️  NO COMPLETED ORDERS FOUND!`);
      console.log(`   This is why TAT is not updating - need at least 3 completed orders for reliable calculation.`);
      
      // Show recent orders for context
      const recentOrders = allOrders.slice(0, 5);
      console.log(`\n📋 Recent Orders (last 5):`);
      recentOrders.forEach((order, i) => {
        console.log(`   ${i + 1}. Order #${order.id}: ${order.orderStatus} (Created: ${new Date(order.orderDate).toLocaleDateString()})`);
      });
      
      process.exit(0);
    }
    
    // 4. Calculate TAT for each completed order
    console.log(`\n🧮 TAT Calculations:`);
    const tatCalculations = completedOrders.map((order, index) => {
      const orderDate = new Date(order.orderDate);
      const completedDate = new Date(order.completedDate);
      const tatDays = Math.ceil((completedDate - orderDate) / (1000 * 60 * 60 * 24));
      
      console.log(`   Order #${order.id}: ${tatDays} days (${orderDate.toLocaleDateString()} → ${completedDate.toLocaleDateString()})`);
      
      return {
        orderId: order.id,
        tat: Math.max(0, tatDays),
        orderDate: orderDate,
        completedDate: completedDate
      };
    });
    
    // 5. Calculate what the TAT should be
    if (tatCalculations.length >= 3) {
      // Calculate weighted average (same as the service)
      let totalWeightedTAT = 0;
      let totalWeight = 0;
      
      tatCalculations.forEach((calc, index) => {
        const weight = Math.pow(0.9, index); // More recent orders get higher weight
        totalWeightedTAT += calc.tat * weight;
        totalWeight += weight;
      });
      
      const calculatedTAT = Math.round(totalWeightedTAT / totalWeight);
      const calculatedPlacementSpeed = calculatePlacementSpeed(calculatedTAT);
      
      console.log(`\n🎯 Expected TAT Calculation:`);
      console.log(`   Calculated TAT: ${calculatedTAT} days`);
      console.log(`   Expected Placement Speed: ${calculatedPlacementSpeed}`);
      console.log(`   Current TAT: ${website.tat} days`);
      console.log(`   Current Placement Speed: ${website.placement_speed}`);
      
      if (website.tat !== calculatedTAT || website.placement_speed !== calculatedPlacementSpeed) {
        console.log(`   🔄 TAT NEEDS UPDATE!`);
        
        // 6. Try to update TAT manually
        console.log(`\n🔧 Attempting manual TAT update...`);
        try {
          const marketplaceService = app.service('api::marketplace.marketplace');
          const result = await marketplaceService.updateTATFromCompletedOrders(websiteId, {
            minOrderCount: 1, // Lower threshold for testing
            lookbackDays: 365,
            useWeightedAverage: true
          });
          
          if (result) {
            console.log(`   ✅ TAT Updated Successfully!`);
            console.log(`      Previous TAT: ${result.previousTAT} days`);
            console.log(`      New TAT: ${result.newTAT} days`);
            console.log(`      Placement Speed: ${result.placementSpeed}`);
            console.log(`      Orders analyzed: ${result.ordersAnalyzed}`);
          } else {
            console.log(`   ❌ TAT Update Failed - insufficient data`);
          }
        } catch (error) {
          console.error(`   ❌ TAT Update Error:`, error.message);
        }
      } else {
        console.log(`   ✅ TAT is already up to date!`);
      }
    } else {
      console.log(`   ⚠️  Only ${tatCalculations.length} completed orders found.`);
      console.log(`   Need at least 3 completed orders for reliable TAT calculation.`);
    }
    
    // 7. Check for recent order completion
    const recentCompletions = completedOrders.filter(order => {
      const completedDate = new Date(order.completedDate);
      const hoursSinceCompletion = (Date.now() - completedDate.getTime()) / (1000 * 60 * 60);
      return hoursSinceCompletion <= 24; // Within last 24 hours
    });
    
    if (recentCompletions.length > 0) {
      console.log(`\n⏰ Recent Completions (last 24 hours):`);
      recentCompletions.forEach(order => {
        const completedDate = new Date(order.completedDate);
        const hoursAgo = Math.round((Date.now() - completedDate.getTime()) / (1000 * 60 * 60));
        console.log(`   Order #${order.id}: Completed ${hoursAgo} hours ago`);
      });
      console.log(`   💡 If you just completed an order, TAT should update automatically.`);
      console.log(`   💡 Check server logs for TAT update messages.`);
    }
    
    console.log(`\n🎉 TAT debugging completed!`);
    
    if (completedOrders.length < 3) {
      console.log(`\n💡 SOLUTION: Complete more orders to enable automatic TAT updates.`);
    } else {
      console.log(`\n💡 If TAT is still not updating automatically, check:`);
      console.log(`   1. Server logs for TAT update errors`);
      console.log(`   2. Order completion is setting completedDate properly`);
      console.log(`   3. Frontend cache - try refreshing the page`);
    }
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Debug failed:', error);
    process.exit(1);
  }
}

// Helper function to calculate placement speed
function calculatePlacementSpeed(tat) {
  if (!tat || tat < 0) return 'Normal';
  
  if (tat >= 0 && tat <= 2) return 'Ultra Fast';
  if (tat >= 3 && tat <= 5) return 'Fast';
  if (tat >= 6 && tat <= 8) return 'Normal';
  if (tat >= 9 && tat <= 20) return 'Slow';
  
  return 'Slow';
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⚠️ Debug interrupted');
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\n⚠️ Debug terminated');
  process.exit(1);
});

// Run the debug
debugTAT(); 