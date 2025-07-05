/**
 * Migration script to calculate placement_speed based on existing TAT values
 * Run this script after deploying the new placement_speed field
 */

const strapi = require('@strapi/strapi');

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

async function migratePlacementSpeed() {
  console.log('🚀 Starting placement speed migration...');
  
  try {
    // Initialize Strapi
    const strapiInstance = strapi();
    await strapiInstance.load();
    
    // Get all marketplace entries
    const entries = await strapi.entityService.findMany('api::marketplace.marketplace', {
      fields: ['id', 'url', 'tat', 'placement_speed'],
      pagination: {
        page: 1,
        pageSize: 1000 // Adjust based on your data size
      }
    });
    
    console.log(`📊 Found ${entries.length} marketplace entries to process`);
    
    let updatedCount = 0;
    let skippedCount = 0;
    
    // Process each entry
    for (const entry of entries) {
      try {
        const newPlacementSpeed = calculatePlacementSpeed(entry.tat);
        
        // Only update if placement_speed is different or empty
        if (!entry.placement_speed || entry.placement_speed !== newPlacementSpeed) {
          await strapi.entityService.update('api::marketplace.marketplace', entry.id, {
            data: {
              placement_speed: newPlacementSpeed
            }
          });
          
          console.log(`✅ Updated ${entry.url}: TAT ${entry.tat} days → ${newPlacementSpeed}`);
          updatedCount++;
        } else {
          skippedCount++;
        }
      } catch (error) {
        console.error(`❌ Error updating entry ${entry.id}:`, error.message);
      }
    }
    
    console.log('\n📈 Migration Summary:');
    console.log(`   Total entries processed: ${entries.length}`);
    console.log(`   Successfully updated: ${updatedCount}`);
    console.log(`   Skipped (no change needed): ${skippedCount}`);
    console.log('\n✨ Migration completed successfully!');
    
  } catch (error) {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  } finally {
    // Close Strapi instance
    await strapi.destroy();
    process.exit(0);
  }
}

// Run migration
migratePlacementSpeed(); 