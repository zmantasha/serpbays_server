const axios = require('axios');

async function testPagination() {
  const baseUrl = 'http://localhost:1337/api/admin/websites';
  
  try {
    console.log('Testing pagination...\n');
    
    // First, let's try to get a session or check if we need authentication
    console.log('=== Testing without authentication first ===');
    try {
      const response1 = await axios.get(`${baseUrl}?page=1&pageSize=10`);
      console.log('Response status:', response1.status);
      console.log('Pagination meta:', response1.data.meta?.pagination);
      console.log('First 3 website IDs:', response1.data.data?.slice(0, 3).map(w => w.id));
      console.log('Total websites returned:', response1.data.data?.length);
    } catch (error) {
      console.log('Error without auth:', error.response?.status, error.response?.data?.error?.message);
    }
    
    // Try with different endpoint structure
    console.log('\n=== Testing with different endpoint ===');
    try {
      const response2 = await axios.get(`http://localhost:1337/api/api/admin/websites?page=1&pageSize=10`);
      console.log('Response status:', response2.status);
      console.log('Pagination meta:', response2.data.meta?.pagination);
      console.log('First 3 website IDs:', response2.data.data?.slice(0, 3).map(w => w.id));
      console.log('Total websites returned:', response2.data.data?.length);
    } catch (error) {
      console.log('Error with different endpoint:', error.response?.status, error.response?.data?.error?.message);
    }
    
  } catch (error) {
    console.error('Error testing pagination:', error.response?.data || error.message);
  }
}

testPagination();
