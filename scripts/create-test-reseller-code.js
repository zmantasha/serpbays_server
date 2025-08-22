const axios = require('axios');

// Configuration
const STRAPI_URL = 'http://localhost:1337';
const ADMIN_EMAIL = 'admin@example.com'; // Update with your admin email
const ADMIN_PASSWORD = 'password123'; // Update with your admin password

async function createTestResellerCode() {
  try {
    console.log('🚀 Creating test reseller code...');

    // First, login as admin to get auth token
    const loginResponse = await axios.post(`${STRAPI_URL}/api/auth/local`, {
      identifier: ADMIN_EMAIL,
      password: ADMIN_PASSWORD
    });

    const authToken = loginResponse.data.jwt;
    console.log('✅ Admin authenticated');

    // Create a test reseller code
    const resellerCodeData = {
      code: 'TEST-RESELLER-001',
      assignedToName: 'Test Reseller',
      usageLimit: 10,
      isActive: true,
      notes: 'Test reseller code for development'
    };

    const createResponse = await axios.post(`${STRAPI_URL}/api/reseller-codes`, {
      data: resellerCodeData
    }, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Test reseller code created successfully!');
    console.log('Code:', createResponse.data.data.attributes.code);
    console.log('Usage Limit:', createResponse.data.data.attributes.usageLimit);
    console.log('');
    console.log('🧪 You can test the frontend with code: TEST-RESELLER-001');

  } catch (error) {
    console.error('❌ Error creating reseller code:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      console.log('');
      console.log('💡 Make sure to:');
      console.log('1. Update ADMIN_EMAIL and ADMIN_PASSWORD in this script');
      console.log('2. Ensure Strapi is running on localhost:1337');
      console.log('3. Create an admin user in Strapi admin panel first');
    }
  }
}

// Run the script
createTestResellerCode();
