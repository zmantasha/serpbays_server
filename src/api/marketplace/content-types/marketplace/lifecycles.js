// Helper function to calculate placement speed based on TAT
function calculatePlacementSpeed(tat) {
  if (!tat || tat < 0) return 'Normal';
  
  if (tat >= 0 && tat <= 2) return 'Ultra Fast';
  if (tat >= 3 && tat <= 5) return 'Fast';
  if (tat >= 6 && tat <= 8) return 'Normal';
  if (tat >= 9 && tat <= 20) return 'Slow';
  
  // For TAT > 20 days, consider it Slow
  return 'Slow';
}

module.exports = {
  // Before creating a new marketplace entry
  beforeCreate(event) {
    const { data } = event.params;
    
    // Calculate placement speed if TAT is provided
    if (data.tat !== undefined) {
      data.placement_speed = calculatePlacementSpeed(data.tat);
    }
  },

  // Before updating a marketplace entry
  beforeUpdate(event) {
    const { data } = event.params;
    
    // Recalculate placement speed if TAT is being updated
    if (data.tat !== undefined) {
      data.placement_speed = calculatePlacementSpeed(data.tat);
    }
  },

  // After creating - log for debugging (optional)
  afterCreate(event) {
    const { result } = event;
    console.log(`Marketplace created: ${result.url} - TAT: ${result.tat} days, Placement Speed: ${result.placement_speed}`);
  },

  // After updating - log for debugging (optional)  
  afterUpdate(event) {
    const { result } = event;
    if (result.tat !== undefined) {
      console.log(`Marketplace updated: ${result.url} - TAT: ${result.tat} days, Placement Speed: ${result.placement_speed}`);
    }
  }
}; 