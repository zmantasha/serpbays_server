// Direct database creation of reseller code
// Run this with: npm run strapi script scripts/direct-create-reseller-code.js

module.exports = async ({ strapi }) => {
  try {
    console.log('Creating test reseller code directly in database...');
    
    // Create reseller code directly via entityService
    const resellerCode = await strapi.entityService.create('api::reseller-code.reseller-code', {
      data: {
        code: 'TEST-RESELLER-001',
        assignedToName: 'Test Reseller',
        usageLimit: 10,
        usedCount: 0,
        isActive: true,
        notes: 'Test reseller code for development',
        publishedAt: new Date()
      }
    });
    
    console.log('✅ Test reseller code created successfully!');
    console.log('Code:', resellerCode.code);
    console.log('Usage Limit:', resellerCode.usageLimit);
    console.log('ID:', resellerCode.id);
    
    // Test validation
    const validation = await strapi.service('api::reseller-code.reseller-code').validateCode('TEST-RESELLER-001');
    console.log('Validation test:', validation);
    
    console.log('🧪 You can now test the frontend with code: TEST-RESELLER-001');
    
  } catch (error) {
    console.error('❌ Error creating reseller code:', error);
  }
};
