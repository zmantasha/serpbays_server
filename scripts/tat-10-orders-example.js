#!/usr/bin/env node

/**
 * TAT Calculation Example for 10 Orders
 * 
 * This script shows exactly how TAT is calculated when you have 10 completed orders
 * 
 * Usage: node scripts/tat-10-orders-example.js
 */

function calculatePlacementSpeed(tat) {
  if (!tat || tat < 0) return 'Normal';
  if (tat >= 0 && tat <= 2) return 'Ultra Fast';
  if (tat >= 3 && tat <= 5) return 'Fast';
  if (tat >= 6 && tat <= 8) return 'Normal';
  if (tat >= 9) return 'Slow';
  return 'Normal';
}

function calculateDetailedWeightedAverage(tatValues) {
  console.log('\n📊 DETAILED TAT CALCULATION');
  console.log('═'.repeat(80));
  
  let totalWeightedTAT = 0;
  let totalWeight = 0;
  
  console.log('Order | TAT Days | Weight    | Contribution | Running Total');
  console.log('------|----------|-----------|--------------|---------------');
  
  tatValues.forEach((tat, index) => {
    const weight = Math.pow(0.9, index);
    const contribution = tat * weight;
    totalWeightedTAT += contribution;
    totalWeight += weight;
    
    console.log(
      `${(index + 1).toString().padStart(5)} | ` +
      `${tat.toString().padStart(8)} | ` +
      `${weight.toFixed(6).padStart(9)} | ` +
      `${contribution.toFixed(6).padStart(12)} | ` +
      `${totalWeightedTAT.toFixed(6).padStart(13)}`
    );
  });
  
  console.log('------|----------|-----------|--------------|---------------');
  console.log(`TOTAL |          | ${totalWeight.toFixed(6).padStart(9)} | ${totalWeightedTAT.toFixed(6).padStart(12)} |`);
  
  const finalTAT = Math.round(totalWeightedTAT / totalWeight);
  const placementSpeed = calculatePlacementSpeed(finalTAT);
  
  console.log('\n🎯 FINAL CALCULATION:');
  console.log(`Final TAT = ${totalWeightedTAT.toFixed(6)} ÷ ${totalWeight.toFixed(6)} = ${(totalWeightedTAT / totalWeight).toFixed(2)} ≈ ${finalTAT} days`);
  console.log(`Placement Speed: ${placementSpeed}`);
  
  return {
    finalTAT,
    placementSpeed,
    totalWeightedTAT,
    totalWeight,
    exactAverage: totalWeightedTAT / totalWeight
  };
}

console.log('🎯 TAT CALCULATION FOR 10 ORDERS');
console.log('═'.repeat(50));

// Example: 10 completed orders (most recent first)
const orders = [
  { id: 101, tat: 4, date: '2024-12-10', description: 'Most recent - good performance' },
  { id: 102, tat: 6, date: '2024-12-08', description: 'Slightly slower' },
  { id: 103, tat: 3, date: '2024-12-05', description: 'Fast completion' },
  { id: 104, tat: 8, date: '2024-12-02', description: 'Slower order' },
  { id: 105, tat: 5, date: '2024-11-28', description: 'Average performance' },
  { id: 106, tat: 7, date: '2024-11-25', description: 'Bit slower' },
  { id: 107, tat: 2, date: '2024-11-20', description: 'Very fast order' },
  { id: 108, tat: 9, date: '2024-11-15', description: 'Slow completion' },
  { id: 109, tat: 4, date: '2024-11-10', description: 'Good performance' },
  { id: 110, tat: 6, date: '2024-11-05', description: 'Oldest order' }
];

console.log('\n📦 YOUR 10 COMPLETED ORDERS:');
console.log('(Listed from most recent to oldest)');
console.log('─'.repeat(50));

orders.forEach((order, index) => {
  console.log(`${index + 1}. Order #${order.id}: ${order.tat} days (${order.date}) - ${order.description}`);
});

const tatValues = orders.map(order => order.tat);
console.log(`\n📊 TAT Values: [${tatValues.join(', ')}] days`);

// Calculate weighted average
const result = calculateDetailedWeightedAverage(tatValues);

// Compare with simple average
const simpleAverage = tatValues.reduce((sum, tat) => sum + tat, 0) / tatValues.length;
console.log('\n🔄 COMPARISON:');
console.log(`Simple Average: ${simpleAverage.toFixed(2)} days (all orders have equal weight)`);
console.log(`Weighted Average: ${result.exactAverage.toFixed(2)} days (recent orders matter more)`);
console.log(`Final TAT: ${result.finalTAT} days`);

// Show impact of recent vs old orders
console.log('\n📈 WEIGHT IMPACT ANALYSIS:');
console.log('Recent orders (1-3) combined weight:', 
  (1.0 + 0.9 + 0.81).toFixed(3), 
  `(${((1.0 + 0.9 + 0.81) / result.totalWeight * 100).toFixed(1)}% influence)`
);
console.log('Middle orders (4-7) combined weight:', 
  (Math.pow(0.9, 3) + Math.pow(0.9, 4) + Math.pow(0.9, 5) + Math.pow(0.9, 6)).toFixed(3),
  `(${((Math.pow(0.9, 3) + Math.pow(0.9, 4) + Math.pow(0.9, 5) + Math.pow(0.9, 6)) / result.totalWeight * 100).toFixed(1)}% influence)`
);
console.log('Oldest orders (8-10) combined weight:', 
  (Math.pow(0.9, 7) + Math.pow(0.9, 8) + Math.pow(0.9, 9)).toFixed(3),
  `(${((Math.pow(0.9, 7) + Math.pow(0.9, 8) + Math.pow(0.9, 9)) / result.totalWeight * 100).toFixed(1)}% influence)`
);

console.log('\n💡 KEY INSIGHTS:');
console.log('1. 🎯 Most recent 3 orders have ~60% of total influence');
console.log('2. 🔄 Middle 4 orders have ~30% of total influence');  
console.log('3. 📉 Oldest 3 orders have only ~10% influence');
console.log('4. ⚡ System adapts quickly to recent performance changes');
console.log('5. 📊 Current placement speed category:', result.placementSpeed);

// Show what happens if recent performance changes
console.log('\n🚀 PERFORMANCE CHANGE SIMULATION:');
console.log('If your next 3 orders complete in 2 days each:');

const improvedOrders = [2, 2, 2, ...tatValues.slice(0, 7)]; // Replace 3 most recent
const improvedResult = calculateDetailedWeightedAverage(improvedOrders);
console.log(`New TAT would be: ${improvedResult.finalTAT} days (${improvedResult.placementSpeed})`);

console.log('\nIf your next 3 orders take 10 days each:');
const degradedOrders = [10, 10, 10, ...tatValues.slice(0, 7)]; // Replace 3 most recent  
const degradedResult = calculateDetailedWeightedAverage(degradedOrders);
console.log(`New TAT would be: ${degradedResult.finalTAT} days (${degradedResult.placementSpeed})`);

console.log('\n🎉 This is exactly how your TAT is calculated with 10 orders!');
console.log('Each new order completion will update this calculation automatically.');

// Show the actual code used in the server
console.log('\n💻 SERVER CODE EQUIVALENT:');
console.log('```javascript');
console.log('function calculateWeightedTAT(tatValues) {');
console.log('  let totalWeightedTAT = 0;');
console.log('  let totalWeight = 0;');
console.log('  ');
console.log('  tatValues.forEach((tat, index) => {');
console.log('    const weight = Math.pow(0.9, index);');
console.log('    totalWeightedTAT += tat * weight;');
console.log('    totalWeight += weight;');
console.log('  });');
console.log('  ');
console.log('  return Math.round(totalWeightedTAT / totalWeight);');
console.log('}');
console.log('```'); 