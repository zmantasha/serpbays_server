const axios = require('axios');

// Simple script to create test reseller code by bypassing auth
// This creates via direct Strapi service call

const createResellerCode = async () => {
  try {
    console.log('Creating test reseller code directly...');
    
    // This would normally be done via admin panel, but for testing:
    // Just hit the validation endpoint to see if it works
    const testResponse = await axios.get('http://localhost:1337/api/reseller-codes/validate/TEST-RESELLER-001');
    console.log('Test validation response:', testResponse.data);
    
    console.log('✅ API is working. You need to:');
    console.log('1. Go to http://localhost:1337/admin');
    console.log('2. Create an admin user if you haven\'t');
    console.log('3. Go to Content Manager > Reseller Code');
    console.log('4. Create a new reseller code with:');
    console.log('   - Code: TEST-RESELLER-001');
    console.log('   - Usage Limit: 10');
    console.log('   - Is Active: true');
    console.log('   - Assigned To Name: Test Reseller');
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
};

createResellerCode();
