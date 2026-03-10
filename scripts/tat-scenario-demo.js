#!/usr/bin/env node

/**
 * TAT Scenario Demonstration
 * 
 * This script demonstrates exactly how TAT should behave in different scenarios
 * 
 * Usage: node scripts/tat-scenario-demo.js
 */

function calculatePlacementSpeed(tat) {
  if (!tat || tat < 0) return 'Normal';
  if (tat >= 0 && tat <= 2) return 'Ultra Fast';
  if (tat >= 3 && tat <= 5) return 'Fast';
  if (tat >= 6 && tat <= 8) return 'Normal';
  if (tat >= 9) return 'Slow';
  return 'Normal';
}

function calculateWeightedAverage(tatValues, useWeighted = true) {
  if (tatValues.length === 0) return null;
  
  if (!useWeighted) {
    // Simple average
    return Math.round(tatValues.reduce((sum, tat) => sum + tat, 0) / tatValues.length);
  }
  
  // Weighted average (more recent orders have higher weight)
  let totalWeightedTAT = 0;
  let totalWeight = 0;
  
  tatValues.forEach((tat, index) => {
    const weight = Math.pow(0.9, index); // Exponential decay
    totalWeightedTAT += tat * weight;
    totalWeight += weight;
  });
  
  return Math.round(totalWeightedTAT / totalWeight);
}

function printScenario(scenarioName, orders, minOrderCount = 3) {
  console.log(`\n🎬 ${scenarioName}`);
  console.log('═'.repeat(50));
  
  if (orders.length === 0) {
    console.log('📊 Status: No completed orders');
    console.log('🎯 TAT: 7 days (static default)');
    console.log('⚡ Placement Speed: Normal');
    console.log('💡 Reason: No order history available');
    return;
  }
  
  // Show order details
  console.log('📦 Completed Orders:');
  orders.forEach((order, i) => {
    console.log(`   Order ${i + 1}: ${order.tat} days (${order.startDate} → ${order.endDate})`);
  });
  
  const tatValues = orders.map(o => o.tat);
  console.log(`📊 Individual TAT values: [${tatValues.join(', ')}] days`);
  
  if (orders.length < minOrderCount) {
    console.log(`⚠️  Status: Insufficient orders (${orders.length}/${minOrderCount})`);
    console.log('🎯 TAT: 7 days (static - unchanged)');
    console.log('⚡ Placement Speed: Normal');
    console.log('💡 Reason: Need at least 3 orders for reliable calculation');
    return;
  }
  
  // Calculate both averages for comparison
  const simpleAvg = calculateWeightedAverage(tatValues, false);
  const weightedAvg = calculateWeightedAverage(tatValues, true);
  const placementSpeed = calculatePlacementSpeed(weightedAvg);
  
  console.log(`🧮 Simple Average: ${simpleAvg} days`);
  console.log(`🧮 Weighted Average: ${weightedAvg} days (recent orders matter more)`);
  console.log(`🎯 Final TAT: ${weightedAvg} days`);
  console.log(`⚡ Placement Speed: ${placementSpeed}`);
  
  // Show weight breakdown
  console.log('\n📊 Weight Breakdown:');
  tatValues.forEach((tat, index) => {
    const weight = Math.pow(0.9, index);
    const contribution = tat * weight;
    console.log(`   Order ${index + 1}: ${tat} days × ${weight.toFixed(2)} weight = ${contribution.toFixed(2)}`);
  });
  
  const totalWeight = tatValues.reduce((sum, _, index) => sum + Math.pow(0.9, index), 0);
  console.log(`   Total weighted sum: ${tatValues.reduce((sum, tat, index) => sum + (tat * Math.pow(0.9, index)), 0).toFixed(2)}`);
  console.log(`   Total weight: ${totalWeight.toFixed(2)}`);
  console.log(`   Result: ${(tatValues.reduce((sum, tat, index) => sum + (tat * Math.pow(0.9, index)), 0) / totalWeight).toFixed(2)} ≈ ${weightedAvg} days`);
}

console.log('🎭 TAT System Behavior Demonstration');
console.log('This shows exactly how TAT should update in different scenarios\n');

// Scenario 1: No orders
printScenario('Initial State - No Orders', []);

// Scenario 2: First order (with minOrderCount = 1 for testing)
console.log('\n🔧 Testing Mode (minOrderCount = 1):');
printScenario('After 1st Order (Testing Mode)', [
  { tat: 3, startDate: '2024-01-01', endDate: '2024-01-04' }
], 1);

printScenario('After 2nd Order (Testing Mode)', [
  { tat: 5, startDate: '2024-01-05', endDate: '2024-01-10' },  // Most recent
  { tat: 3, startDate: '2024-01-01', endDate: '2024-01-04' }   // Older
], 1);

// Scenario 3: Production mode (minOrderCount = 3)
console.log('\n🏭 Production Mode (minOrderCount = 3):');
printScenario('After 1st Order (Production)', [
  { tat: 3, startDate: '2024-01-01', endDate: '2024-01-04' }
]);

printScenario('After 2nd Order (Production)', [
  { tat: 5, startDate: '2024-01-05', endDate: '2024-01-10' },
  { tat: 3, startDate: '2024-01-01', endDate: '2024-01-04' }
]);

printScenario('After 3rd Order (Production)', [
  { tat: 7, startDate: '2024-01-11', endDate: '2024-01-18' },  // Most recent
  { tat: 5, startDate: '2024-01-05', endDate: '2024-01-10' },
  { tat: 3, startDate: '2024-01-01', endDate: '2024-01-04' }   // Oldest
]);

printScenario('After 4th Order - Improved Performance', [
  { tat: 2, startDate: '2024-01-19', endDate: '2024-01-21' },  // Most recent - much faster!
  { tat: 7, startDate: '2024-01-11', endDate: '2024-01-18' },
  { tat: 5, startDate: '2024-01-05', endDate: '2024-01-10' },
  { tat: 3, startDate: '2024-01-01', endDate: '2024-01-04' }   // Oldest
]);

printScenario('After 5th Order - Degraded Performance', [
  { tat: 12, startDate: '2024-01-22', endDate: '2024-02-03' }, // Most recent - much slower!
  { tat: 2, startDate: '2024-01-19', endDate: '2024-01-21' },
  { tat: 7, startDate: '2024-01-11', endDate: '2024-01-18' },
  { tat: 5, startDate: '2024-01-05', endDate: '2024-01-10' },
  { tat: 3, startDate: '2024-01-01', endDate: '2024-01-04' }
]);

console.log('\n🎯 Key Takeaways:');
console.log('══════════════════');
console.log('1. 📊 TAT only updates when you have enough completed orders');
console.log('2. 🎯 Recent orders have MORE influence than older ones');
console.log('3. ⚡ Placement speed automatically adjusts based on TAT');
console.log('4. 🔄 Each new completion can change the TAT immediately');
console.log('5. 📈 System adapts quickly to performance improvements');
console.log('6. 📉 System also detects performance degradation');

console.log('\n🔧 Current Server Settings:');
console.log('minOrderCount: 1 (for testing - normally 3)');
console.log('lookbackDays: 365 (considers orders from last year)');
console.log('useWeightedAverage: true (recent orders matter more)');

console.log('\n💡 To check your actual website:');
console.log('node scripts/debug-tat.js <your-website-id>');
console.log('node scripts/manual-tat-update.js <your-website-id>'); 