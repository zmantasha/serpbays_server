#!/usr/bin/env node

/**
 * Test script to verify cascade deletion functionality
 * This script tests that when a website is deleted from publisher-website,
 * it's also automatically deleted from marketplace
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:1337';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'your-admin-token-here';

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${ADMIN_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

async function testCascadeDeletion() {
  console.log('🧪 Testing Cascade Deletion Functionality...\n');

  try {
    // Step 1: Create a test website
    console.log('1️⃣ Creating a test website...');
    const testWebsite = {
      url: 'test-cascade-deletion.com',
      publisherEmail: 'test@example.com',
      publisherName: 'Test Publisher',
      description: 'Test website for cascade deletion',
      submissionStatus: 'approval_pending'
    };

    const createResponse = await api.post('/api/publisher-websites', {
      data: testWebsite
    });
    
    const websiteId = createResponse.data.data.id;
    console.log(`✅ Test website created with ID: ${websiteId}`);

    // Step 2: Approve the website to create marketplace entry
    console.log('\n2️⃣ Approving website to create marketplace entry...');
    await api.put(`/api/admin/websites/${websiteId}/approve`);
    console.log('✅ Website approved');

    // Step 3: Verify marketplace entry was created
    console.log('\n3️⃣ Verifying marketplace entry was created...');
    const marketplaceResponse = await api.get('/api/marketplaces', {
      params: {
        filters: { url: testWebsite.url }
      }
    });

    if (marketplaceResponse.data.data.length > 0) {
      const marketplaceId = marketplaceResponse.data.data[0].id;
      console.log(`✅ Marketplace entry found with ID: ${marketplaceId}`);
    } else {
      console.log('❌ No marketplace entry found - this might be expected if approval didn\'t create one');
    }

    // Step 4: Delete the website
    console.log('\n4️⃣ Deleting the website...');
    await api.delete(`/api/admin/websites/${websiteId}`);
    console.log('✅ Website deleted');

    // Step 5: Verify marketplace entry was also deleted
    console.log('\n5️⃣ Verifying marketplace entry was also deleted...');
    const verifyResponse = await api.get('/api/marketplaces', {
      params: {
        filters: { url: testWebsite.url }
      }
    });

    if (verifyResponse.data.data.length === 0) {
      console.log('✅ SUCCESS: Marketplace entry was automatically deleted!');
      console.log('🎉 Cascade deletion is working correctly!');
    } else {
      console.log('❌ FAILED: Marketplace entry still exists after website deletion');
      console.log('🔧 Cascade deletion is not working properly');
    }

  } catch (error) {
    console.error('❌ Test failed with error:', error.response?.data || error.message);
  }
}

// Run the test
if (require.main === module) {
  testCascadeDeletion()
    .then(() => {
      console.log('\n🏁 Test completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test crashed:', error);
      process.exit(1);
    });
}

module.exports = { testCascadeDeletion };
